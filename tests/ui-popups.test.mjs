import test from "node:test";
import assert from "node:assert/strict";
import {
  createAlertDialog,
  createCollapsible,
  createDialog,
  createDrawer,
  createDrawerProvider,
  createDrawerVirtualKeyboardProvider,
  createPopover,
  createPreviewCard,
  createTooltip,
  createTooltipProvider,
} from "../dist/ui-popups.js";

test("collapsible supports cancelable controlled-quality transitions and a live manifest", () => {
  const changes = [];
  const collapsible = createCollapsible({
    id: "filters",
    onOpenChange(open, details) {
      changes.push([open, details.reason]);
      if (!open) details.cancel();
    },
  });
  const trigger = collapsible.trigger();
  trigger.onClick({ defaultPrevented: false });
  assert.equal(collapsible.open.value, true);
  assert.equal(collapsible.hide(), false);
  assert.equal(collapsible.open.value, true);
  assert.deepEqual(changes, [[true, "trigger-press"], [false, "programmatic"]]);
  assert.equal(collapsible.manifest().protocol, "clank-ui/1");
  assert.ok(collapsible.manifest().actions.every((action) => action.sideEffects === "write"));
  collapsible.dispose();
});

test("collapsible wires custom ids and supports searchable and lazy panel presence", async () => {
  const changes = [];
  const collapsible = createCollapsible({
    id: "advanced-filters",
    onOpenChange(open, details) { changes.push([open, details.reason]); },
  });
  const trigger = collapsible.trigger({ id: "filter-toggle" });
  const panel = collapsible.panel({ id: "filter-results", hiddenUntilFound: true });
  assert.equal(trigger["aria-controls"](), "filter-results");
  assert.equal(panel["aria-labelledby"](), "filter-toggle");
  assert.equal(collapsible.isPanelMounted(), false);
  assert.equal(collapsible.isPanelMounted({ keepMounted: true }), true);
  assert.equal(collapsible.isPanelMounted({ hiddenUntilFound: true }), true);
  assert.equal(panel.hidden(), "until-found");
  panel.onBeforeMatch(basicEvent());
  assert.equal(collapsible.open.value, true);
  assert.deepEqual(changes, [[true, "beforematch"]]);
  collapsible.hide();
  assert.equal(collapsible.isPanelMounted(), true, "exit content remains mounted until presence completes");
  await Promise.resolve();
  assert.equal(collapsible.isPanelMounted(), false);
  collapsible.dispose();
});

test("dialogs and alert dialogs expose correct roles and dismissal policies", () => {
  const dialog = createDialog({ id: "invite" });
  const alert = createAlertDialog({ id: "delete" });
  assert.equal(dialog.backdrop().hidden(), true);
  assert.equal(dialog.popup().hidden(), true);
  assert.equal(dialog.dialog().role, "dialog");
  assert.equal(alert.dialog().role, "alertdialog");
  assert.equal(dialog.trigger()["aria-haspopup"], "dialog");
  assert.equal(dialog.title().id, "invite-title");
  assert.equal(dialog.description().id, "invite-description");
  dialog.show();
  assert.equal(dialog.backdrop().hidden(), false);
  assert.equal(dialog.popup().hidden(), false);
  dialog.dispose();
  alert.dispose();
});

test("popup portals expose lazy mounting without truncating exit presence", async () => {
  const dialog = createDialog({ id: "lazy-dialog" });
  assert.equal(dialog.isMounted(), false);
  assert.equal(dialog.portal().hidden(), true);
  assert.equal(dialog.isMounted({ keepMounted: true }), true);
  assert.equal(dialog.portal({ keepMounted: true })["data-mounted"](), "");
  dialog.show();
  assert.equal(dialog.isMounted(), true);
  dialog.hide();
  assert.equal(dialog.isMounted(), true, "the portal remains mounted through its ending state");
  await Promise.resolve();
  assert.equal(dialog.isMounted(), false);
  assert.equal(dialog.portal({ keepMounted: true }).hidden(), true);
  dialog.dispose();

  const kept = createPopover({ id: "kept-popover", keepMounted: true });
  assert.equal(kept.isMounted(), true);
  assert.equal(kept.portal()["data-mounted"](), "");
  kept.dispose();
});

test("popup triggers have unique ids and safely fall back across multiple mounted anchors", () => {
  const popover = createPopover({ id: "multi-trigger-popover" });
  const first = popover.trigger();
  const second = popover.trigger();
  assert.equal(first.id, "multi-trigger-popover-trigger");
  assert.equal(second.id, "multi-trigger-popover-trigger-2");

  const firstElement = { ownerDocument: null, focus() {} };
  const secondElement = { ownerDocument: null, focus() {} };
  first.ref(firstElement);
  second.ref(secondElement);
  assert.equal(popover.triggerElement.value, secondElement, "the latest mounted trigger is the default anchor");
  first.ref(null);
  assert.equal(popover.triggerElement.value, secondElement, "detaching an inactive trigger cannot clear the active one");
  first.ref(firstElement);
  first.onClick(basicEvent({ currentTarget: firstElement }));
  assert.equal(popover.triggerElement.value, firstElement, "interacting with an older trigger makes it active");
  first.ref(null);
  assert.equal(popover.triggerElement.value, secondElement, "detaching the active trigger falls back to the latest mounted trigger");
  second.ref(null);
  assert.equal(popover.triggerElement.value, null);

  const sharedA = popover.trigger({ id: "shared-trigger" });
  const sharedB = popover.trigger({ id: "shared-trigger" });
  sharedA.ref(firstElement);
  assert.throws(() => sharedB.ref(secondElement), /already mounted/);
  sharedA.ref(null);
  sharedB.ref(secondElement);
  sharedA.ref(null);
  assert.equal(popover.triggerElement.value, secondElement, "a stale ref cleanup cannot erase a newer shared-id mount");
  assert.throws(() => popover.trigger({ id: "bad id" }), /id must start/);
  popover.dispose();
  assert.equal(popover.triggerElement.value, null);
});

test("an inactive press transfers popup ownership without closing and later mounts do not steal it", () => {
  const popover = createPopover({ id: "press-owned-popover" });
  const first = popover.trigger();
  const firstElement = { ownerDocument: null, focus() {} };
  first.ref(firstElement);
  first.onClick(basicEvent({ currentTarget: firstElement }));
  assert.equal(popover.open.value, true);
  assert.equal(first["aria-expanded"](), true);

  const second = popover.trigger();
  const secondElement = { ownerDocument: null, focus() {} };
  second.ref(secondElement);
  assert.equal(popover.triggerElement.value, firstElement, "mounting while open preserves the active anchor");
  assert.equal(first["aria-expanded"](), true);
  assert.equal(second["aria-expanded"](), false);

  second.onPointerDown(pointerEvent({ currentTarget: secondElement, pointerType: "mouse" }));
  second.onClick(basicEvent({ currentTarget: secondElement, detail: 1 }));
  assert.equal(popover.open.value, true, "pressing an inactive trigger moves rather than toggles the popup");
  assert.equal(popover.triggerElement.value, secondElement);
  assert.equal(first["aria-expanded"](), false);
  assert.equal(first["data-open"](), undefined);
  assert.equal(second["aria-expanded"](), true);
  assert.equal(second["data-open"](), "");

  second.onPointerDown(pointerEvent({ currentTarget: secondElement, pointerType: "mouse" }));
  second.onClick(basicEvent({ currentTarget: secondElement, detail: 1 }));
  assert.equal(popover.open.value, false, "pressing the active trigger still toggles closed");
  first.ref(null);
  second.ref(null);
  popover.dispose();
});

test("an abandoned inactive pointer press cannot poison a later keyboard trigger click", () => {
  const popover = createPopover({ id: "abandoned-press-popover" });
  const first = popover.trigger();
  const second = popover.trigger();
  const firstElement = { ownerDocument: null, focus() {} };
  const secondElement = { ownerDocument: null, focus() {} };
  first.ref(firstElement);
  second.ref(secondElement);
  first.onClick(basicEvent({ currentTarget: firstElement, detail: 0 }));
  assert.equal(popover.open.value, true);

  const abandoned = pointerEvent({ currentTarget: secondElement, pointerType: "mouse", pointerId: 7 });
  second.onPointerDown(abandoned);
  second.onPointerCancel(pointerEvent({ currentTarget: secondElement, pointerType: "mouse", pointerId: 7 }));
  assert.equal(popover.triggerElement.value, secondElement, "the pointerdown still transfers the active anchor");
  second.onClick(basicEvent({ currentTarget: secondElement, detail: 0 }));
  assert.equal(popover.open.value, false, "a later keyboard/assistive click evaluates current ownership");

  first.ref(null);
  second.ref(null);
  popover.dispose();
});

test("a mounted popup positioner follows the trigger used for each open", () => {
  const view = {
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
    defaultView: view,
    addEventListener() {},
    removeEventListener() {},
  };
  const element = (rect) => ({
    nodeType: 1,
    ownerDocument: document,
    parentElement: null,
    getBoundingClientRect() { return rect; },
    focus() {},
  });
  const firstElement = element({ left: 20, right: 40, top: 10, bottom: 30, width: 20, height: 20 });
  const secondElement = element({ left: 200, right: 240, top: 100, bottom: 130, width: 40, height: 30 });
  const popupElement = element({ left: 0, right: 40, top: 0, bottom: 30, width: 40, height: 30 });
  const popover = createPopover({ id: "switching-anchor-popover", keepMounted: true, avoidCollisions: false });
  const first = popover.trigger();
  const second = popover.trigger();
  first.ref(firstElement);
  second.ref(secondElement);
  const positioner = popover.positioner();
  const cleanup = positioner.use(popupElement);

  first.onClick(basicEvent({ currentTarget: firstElement }));
  assert.equal(styleValue(positioner, "left"), "10px");
  popover.hide();
  second.onClick(basicEvent({ currentTarget: secondElement }));
  assert.equal(styleValue(positioner, "left"), "200px", "the kept positioner follows the new trigger immediately");

  cleanup();
  popover.dispose();
});

test("drawer swipe state is direction-aware and dismisses beyond its threshold", () => {
  const drawer = createDrawer({ id: "mobile-nav", direction: "left", swipeThreshold: 40, defaultOpen: true });
  const props = drawer.popup();
  const target = { setPointerCapture() {} };
  props.onPointerDown({ button: 0, isPrimary: true, pointerId: 4, clientX: 100, currentTarget: target });
  props.onPointerMove({ pointerId: 4, clientX: 40 });
  assert.equal(drawer.dragOffset.value, 60);
  assert.equal(drawer.swipeStrength.value, 1, "the legacy threshold-relative signal remains compatible");
  props.onPointerUp({ pointerId: 4 });
  assert.equal(drawer.open.value, false);
  assert.equal(drawer.dragOffset.value, 0);
  drawer.dispose();
});

test("popup manifests and part props match Base UI anatomy without dangling relationships", () => {
  const dialog = createDialog({ id: "profile" });
  const dialogPopup = dialog.popup();
  assert.equal(dialogPopup["aria-labelledby"](), undefined);
  assert.equal(dialogPopup["aria-describedby"](), undefined);
  dialog.title();
  dialog.description();
  assert.equal(dialogPopup["aria-labelledby"](), "profile-title");
  assert.equal(dialogPopup["aria-describedby"](), "profile-description");
  assert.equal(dialogPopup["aria-modal"], true);
  assert.deepEqual(
    dialog.manifest().parts.map((part) => part.name),
    ["trigger", "portal", "backdrop", "viewport", "popup", "title", "description", "close"],
  );
  assert.equal(dialog.portal()["data-clank-part"], "portal");
  assert.ok(dialog.manifest().actions.every((action) => action.sideEffects === "write"));

  const trapped = createPopover({ id: "trapped", modal: "trap-focus" });
  assert.equal(trapped.popup()["aria-modal"], undefined, "trap-focus does not claim an inert modal background");
  dialog.dispose();
  trapped.dispose();
});

test("tooltip uses description semantics, delayed hover ownership, and provider skip delay", () => {
  const tooltip = createTooltip({ id: "save-help", delay: 0 });
  const trigger = tooltip.trigger();
  assert.equal(trigger["aria-haspopup"], undefined);
  assert.equal(trigger["aria-controls"], undefined);
  assert.equal(trigger["aria-expanded"], undefined);
  assert.equal(trigger["aria-describedby"](), undefined);
  trigger.onPointerEnter(pointerEvent({ pointerType: "mouse" }));
  assert.equal(tooltip.open.value, true);
  assert.equal(trigger["aria-describedby"](), "save-help-popup");
  assert.equal(tooltip.popup().role, "tooltip");
  trigger.onClick(basicEvent());
  assert.equal(tooltip.open.value, false, "click closes rather than reopening a tooltip");
  assert.deepEqual(
    tooltip.manifest().parts.map((part) => part.name),
    ["provider", "trigger", "portal", "positioner", "popup", "arrow", "viewport"],
  );
  tooltip.dispose();

  const provider = createTooltipProvider({ id: "tips", delay: 10_000, timeout: 400 });
  const first = provider.tooltip({ id: "tip-one" });
  const second = provider.tooltip({ id: "tip-two" });
  first.show("hover");
  provider.activate(first);
  second.trigger().onPointerEnter(pointerEvent({ pointerType: "mouse" }));
  assert.equal(second.open.value, true, "an adjacent tooltip opens immediately in the provider instant phase");
  assert.equal(first.open.value, false, "the provider owns only one visible tooltip");
  provider.dispose();
});

test("tooltip providers change ownership only after accepted popup transitions", () => {
  const provider = createTooltipProvider({ id: "guarded-tips", delay: 0, closeDelay: 0 });
  let rejectClose = true;
  const first = provider.tooltip({
    id: "guarded-tip-one",
    onOpenChange(open, details) { if (!open && rejectClose) details.cancel(); },
  });
  const rejected = provider.tooltip({
    id: "guarded-tip-two",
    onOpenChange(open, details) { if (open) details.cancel(); },
  });
  const contender = provider.tooltip({ id: "guarded-tip-three" });
  const firstTrigger = first.trigger();

  firstTrigger.onPointerEnter(pointerEvent({ pointerType: "mouse" }));
  assert.equal(first.open.value, true);
  assert.equal(provider.manifest().state.active, first.id);

  rejected.trigger().onPointerEnter(pointerEvent({ pointerType: "mouse" }));
  assert.equal(rejected.open.value, false);
  assert.equal(first.open.value, true, "a rejected open cannot close the active tooltip");
  assert.equal(provider.manifest().state.active, first.id, "a rejected open cannot take provider ownership");

  contender.trigger().onPointerEnter(pointerEvent({ pointerType: "mouse" }));
  assert.equal(contender.open.value, false, "a new tooltip does not open when the active tooltip vetoes closing");
  assert.equal(first.open.value, true);
  assert.equal(provider.manifest().state.active, first.id);

  assert.equal(first.hide("programmatic"), false);
  assert.equal(first.open.value, true);
  assert.equal(provider.manifest().state.active, first.id, "a rejected close cannot release provider ownership");
  firstTrigger.onClick(basicEvent());
  assert.equal(provider.manifest().state.active, first.id, "a rejected click close cannot release provider ownership");
  rejectClose = false;
  assert.equal(first.hide("programmatic"), true);
  assert.equal(provider.manifest().state.active, null, "an accepted close releases provider ownership");
  provider.dispose();
});

test("hover and focus interactions transfer ownership between popup triggers independently", async () => {
  const preview = createPreviewCard({ id: "owned-preview", delay: 0, closeDelay: 0 });
  const first = preview.trigger();
  const second = preview.trigger();
  const firstElement = { ownerDocument: null, focus() {} };
  const secondElement = { ownerDocument: null, focus() {} };
  first.ref(firstElement);
  second.ref(secondElement);

  first.onPointerEnter(pointerEvent({ pointerType: "mouse", currentTarget: firstElement }));
  assert.equal(preview.open.value, true);
  assert.equal(preview.triggerElement.value, firstElement);
  assert.equal(first["data-open"](), "");
  assert.equal(second["data-open"](), undefined);

  second.onPointerEnter(pointerEvent({ pointerType: "mouse", currentTarget: secondElement }));
  assert.equal(preview.open.value, true);
  assert.equal(preview.triggerElement.value, secondElement);
  assert.equal(first["data-open"](), undefined);
  assert.equal(second["data-open"](), "");
  first.onPointerLeave(pointerEvent({ pointerType: "mouse", currentTarget: firstElement }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(preview.open.value, true, "leaving an inactive trigger cannot close the active hovered trigger");
  second.onPointerLeave(pointerEvent({ pointerType: "mouse", currentTarget: secondElement }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(preview.open.value, false);

  first.onFocus(basicEvent({ currentTarget: firstElement }));
  assert.equal(preview.open.value, true);
  assert.equal(preview.triggerElement.value, firstElement);
  first.onBlur(basicEvent({ currentTarget: firstElement }));
  second.onFocus(basicEvent({ currentTarget: secondElement }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(preview.open.value, true, "focus transfer between triggers cancels the pending close");
  assert.equal(preview.triggerElement.value, secondElement);
  first.ref(null);
  second.ref(null);
  preview.dispose();

  const delayed = createPreviewCard({ id: "delayed-owned-preview", delay: 10, closeDelay: 0 });
  const delayedFirst = delayed.trigger();
  const delayedSecond = delayed.trigger();
  delayedFirst.ref(firstElement);
  delayedSecond.ref(secondElement);
  delayedFirst.onPointerEnter(pointerEvent({ pointerType: "mouse", currentTarget: firstElement }));
  delayedSecond.onPointerEnter(pointerEvent({ pointerType: "mouse", currentTarget: secondElement }));
  delayedFirst.onPointerLeave(pointerEvent({ pointerType: "mouse", currentTarget: firstElement }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(delayed.open.value, true, "leaving another trigger cannot cancel the active trigger's delayed open");
  assert.equal(delayed.triggerElement.value, secondElement);
  delayed.dispose();
});

test("preview cards open from hover/focus without dialog semantics or trigger click hijacking", () => {
  const preview = createPreviewCard({ id: "issue-preview", delay: 0, closeDelay: 0 });
  const trigger = preview.trigger();
  assert.equal(trigger.type, undefined, "the default preview trigger can remain a link");
  assert.equal(trigger.onClick, undefined, "preview navigation is not replaced with popup toggling");
  trigger.onFocus(basicEvent());
  assert.equal(preview.open.value, true);
  assert.equal(preview.popup().role, undefined);
  assert.deepEqual(
    preview.manifest().parts.map((part) => part.name),
    ["trigger", "portal", "backdrop", "positioner", "popup", "arrow", "viewport"],
  );
  preview.dispose();
});

test("drawer exposes drawer-specific anatomy, nested depth, swipe-to-open, and ignore regions", () => {
  const provider = createDrawerProvider({ id: "sheets" });
  const drawer = createDrawer({ id: "settings", provider, direction: "bottom", swipeThreshold: 30 });
  assert.equal(drawer.manifest().component, "Drawer");
  assert.equal(drawer.provider()["data-clank-part"], "provider");
  assert.equal(drawer.indent()["data-clank-part"], "indent");
  assert.equal(drawer.content({ swipeIgnore: true })["data-base-ui-swipe-ignore"], "");
  assert.equal(drawer.swipeArea().style.touchAction, "none");
  assert.equal(provider.depth.value, 0);

  const target = { setPointerCapture() {} };
  const swipe = drawer.swipeArea();
  assert.equal(swipe["data-swipe-direction"], "up", "the edge area advertises its physical opening direction");
  assert.equal(readProp(swipe["data-closed"]), "");
  swipe.onPointerDown(pointerEvent({ pointerId: 8, clientY: 100, currentTarget: target }));
  swipe.onPointerMove(pointerEvent({ pointerId: 8, clientY: 50 }));
  swipe.onPointerUp(pointerEvent({ pointerId: 8, clientY: 50 }));
  assert.equal(drawer.open.value, true, "edge swiping can open a closed drawer");
  assert.equal(readProp(swipe["data-open"]), "");
  assert.equal(provider.depth.value, 1);
  assert.equal(readProp(drawer.indent()["data-active"]), "");

  const ignored = { hasAttribute(name) { return name === "data-base-ui-swipe-ignore"; } };
  const popup = drawer.popup();
  popup.onPointerDown(pointerEvent({ pointerId: 9, clientY: 10, currentTarget: target, composedPath: () => [ignored] }));
  assert.equal(drawer.dragging.value, false);
  assert.ok(drawer.manifest().parts.some((part) => part.name === "virtual-keyboard-provider"));
  drawer.dispose();
  assert.equal(provider.depth.value, 0);
  provider.dispose();
});

test("drawer resolves and deduplicates safe snap points with reactive CSS state", () => {
  const changes = [];
  const drawer = createDrawer({
    id: "snap-sheet",
    defaultOpen: true,
    snapPoints: ["10rem", 0.5, 1],
    onSnapPointChange(value, details) { changes.push([value, details.reason]); },
  });
  assert.equal(drawer.snapPoint.value, "10rem", "the first point is the initial uncontrolled snap");
  assert.deepEqual(drawer.resolvedSnapPoints.value, [], "snap resolution is SSR-safe before measurement");

  drawer.measure({ viewportSize: 600, popupSize: 500, rootFontSize: 16 });
  assert.deepEqual(drawer.resolvedSnapPoints.value, [
    { value: "10rem", size: 160, offset: 340 },
    { value: 0.5, size: 300, offset: 200 },
    { value: 1, size: 500, offset: 0 },
  ]);
  assert.equal(drawer.snapPointOffset.value, 340);
  assert.equal(styleValue(drawer.popup(), "--drawer-snap-point-offset"), "340px");
  assert.equal(readProp(drawer.popup()["data-expanded"]), undefined);

  assert.equal(drawer.setSnapPoint(1), true);
  assert.equal(drawer.snapPoint.value, 1);
  assert.equal(readProp(drawer.popup()["data-expanded"]), "");
  assert.deepEqual(changes, [[1, "programmatic"]]);
  assert.ok(drawer.manifest().actions.some((action) => action.name === "setSnapPoint" && action.sideEffects === "write"));
  assert.deepEqual(drawer.manifest().state.snapPoints, ["10rem", 0.5, 1]);
  drawer.dispose();

  const deduped = createDrawer({ id: "deduped-sheet", snapPoints: [0.5, 200] });
  deduped.measure({ viewportSize: 400, popupSize: 300 });
  assert.deepEqual(deduped.resolvedSnapPoints.value, [{ value: 200, size: 200, offset: 100 }], "the last equivalent point wins like Base UI");
  assert.equal(deduped.snapPointOffset.value, 100, "a deduped active value resolves to its equivalent point");
  deduped.dispose();
});

test("drawer snap state supports controlled requests and cancelable transitions", () => {
  const requests = [];
  const controlled = createDrawer({
    id: "controlled-snap",
    defaultOpen: true,
    snapPoints: [0.5, 1],
    snapPoint: 0.5,
    onSnapPointChange(value, details) { requests.push([value, details.reason]); },
  });
  controlled.measure({ viewportSize: 400, popupSize: 400 });
  assert.equal(controlled.setSnapPoint(1), true);
  assert.equal(controlled.snapPoint.value, 0.5, "an accepted controlled request does not mutate its source");
  assert.deepEqual(requests, [[1, "programmatic"]]);
  controlled.dispose();

  const closeResets = [];
  const controlledOnClose = createDrawer({
    id: "controlled-close-snap",
    defaultOpen: true,
    snapPoints: [1, 0.5],
    snapPoint: 0.5,
    onSnapPointChange(value, details) { closeResets.push([value, details.reason]); },
  });
  controlledOnClose.hide("close-press");
  assert.deepEqual(closeResets, [[1, "close-press"]], "closing requests exactly one initial-snap reset");
  controlledOnClose.dispose();

  const canceled = createDrawer({
    id: "canceled-snap",
    snapPoints: [0.5, 1],
    onSnapPointChange(_value, details) { details.cancel(); },
  });
  assert.equal(canceled.setSnapPoint(1), false);
  assert.equal(canceled.snapPoint.value, 0.5);
  canceled.dispose();
});

test("drawer projects fast snap swipes while sequential mode advances one point", () => {
  const projected = createDrawer({
    id: "projected-snap",
    defaultOpen: true,
    snapPoints: [0.25, 0.5, 0.75, 1],
  });
  projected.measure({ viewportSize: 400, popupSize: 400 });
  performPointerSwipe(projected.popup(), { axis: "y", start: 300, end: 280, startTime: 0, endTime: 10 });
  assert.equal(projected.snapPoint.value, 1, "velocity projection can skip intermediate points");
  projected.dispose();

  const sequential = createDrawer({
    id: "sequential-snap",
    defaultOpen: true,
    snapPoints: [0.25, 0.5, 0.75, 1],
    snapToSequentialPoints: true,
  });
  sequential.measure({ viewportSize: 400, popupSize: 400 });
  performPointerSwipe(sequential.popup(), { axis: "y", start: 300, end: 280, startTime: 0, endTime: 10 });
  assert.equal(sequential.snapPoint.value, 0.5, "sequential mode limits a flick to the adjacent point");
  sequential.dispose();
});

test("drawer release uses distance, resets the initial snap, and honors dismissible/cancellation", () => {
  const changes = [];
  const drawer = createDrawer({
    id: "release-sheet",
    defaultOpen: true,
    snapPoints: [0.5, 0.25, 1],
    swipeThreshold: 40,
    onOpenChange(open, details) { changes.push([open, details.reason]); },
  });
  drawer.measure({ viewportSize: 400, popupSize: 400 });
  performPointerSwipe(drawer.popup(), { axis: "y", start: 100, end: 170, startTime: 0, endTime: 1000 });
  assert.equal(drawer.snapPoint.value, 0.25, "distance selects the nearest collapsed point");
  performPointerSwipe(drawer.popup(), { axis: "y", start: 100, end: 145, startTime: 2000, endTime: 3000 });
  assert.equal(drawer.open.value, false, "the legacy threshold still dismisses from the last snap point");
  assert.equal(drawer.snapPoint.value, 0.5, "closing resets the configured initial snap point");
  assert.equal(readProp(drawer.popup()["data-swipe-dismiss"]), "");
  assert.equal(styleValue(drawer.popup(), "--drawer-snap-point-offset"), "300px");
  assert.equal(styleValue(drawer.popup(), "--drawer-swipe-movement-y"), "100px", "release movement composes to exactly the closed edge");
  const releaseStrength = styleValue(drawer.popup(), "--drawer-swipe-strength");
  assert.ok(releaseStrength >= 0.1 && releaseStrength <= 1, "release velocity produces a bounded transition scalar");
  assert.deepEqual(changes.at(-1), [false, "swipe"]);
  drawer.dispose();

  const fixed = createDrawer({
    id: "fixed-sheet",
    defaultOpen: true,
    snapPoints: [0.25, 1],
    defaultSnapPoint: 0.25,
    dismissible: false,
    swipeThreshold: 20,
  });
  fixed.measure({ viewportSize: 400, popupSize: 400 });
  performPointerSwipe(fixed.popup(), { axis: "y", start: 100, end: 250, startTime: 0, endTime: 1000 });
  assert.equal(fixed.open.value, true, "dismissible=false blocks swipe closing");
  assert.equal(fixed.snapPoint.value, 0.25);
  fixed.dispose();

  const guarded = createDrawer({
    id: "guarded-sheet",
    defaultOpen: true,
    swipeThreshold: 20,
    onOpenChange(open, details) { if (!open) details.cancel(); },
  });
  performPointerSwipe(guarded.popup(), { axis: "y", start: 100, end: 140, startTime: 0, endTime: 1000 });
  assert.equal(guarded.open.value, true, "a canceled close never visually dismisses");
  assert.equal(readProp(guarded.popup()["data-swipe-dismiss"]), undefined);
  assert.equal(guarded.dragging.value, false);
  guarded.dispose();
});

test("drawer supports fast edge opening, fast sub-threshold closing, axis cancellation, and pointer cancellation", async () => {
  const drawer = createDrawer({ id: "gesture-sheet", swipeThreshold: 80 });
  performPointerSwipe(drawer.swipeArea(), { axis: "y", start: 100, end: 90, startTime: 0, endTime: 10 });
  assert.equal(drawer.open.value, true, "a fast edge flick opens below the distance threshold");
  performPointerSwipe(drawer.popup(), { axis: "y", start: 100, end: 110, startTime: 20, endTime: 30 });
  assert.equal(drawer.open.value, false, "a fast dismiss flick closes below the distance threshold");

  drawer.show();
  const popup = drawer.popup();
  const target = pointerTarget();
  popup.onPointerDown(pointerEvent({ pointerId: 31, clientX: 0, clientY: 100, timeStamp: 40, currentTarget: target }));
  popup.onPointerMove(pointerEvent({ pointerId: 31, clientX: 30, clientY: 101, timeStamp: 50 }));
  assert.equal(drawer.dragging.value, false, "a dominant cross-axis gesture is released to native scrolling");
  assert.equal(drawer.open.value, true);

  popup.onPointerDown(pointerEvent({ pointerId: 32, clientY: 100, timeStamp: 60, currentTarget: target }));
  popup.onPointerMove(pointerEvent({ pointerId: 32, clientY: 140, timeStamp: 70 }));
  popup.onPointerCancel(pointerEvent({ pointerId: 32, timeStamp: 80 }));
  assert.equal(drawer.dragging.value, false);
  assert.equal(drawer.dragOffset.value, 0);
  assert.equal(drawer.open.value, true, "pointer cancellation never commits a gesture");
  drawer.dispose();

  const controlledRequests = [];
  const controlled = createDrawer({
    id: "controlled-open-sheet",
    open: true,
    swipeThreshold: 20,
    onOpenChange(open, details) { controlledRequests.push([open, details.reason]); },
  });
  performPointerSwipe(controlled.popup(), { axis: "y", start: 100, end: 130, startTime: 0, endTime: 1000 });
  await Promise.resolve();
  assert.equal(controlled.open.value, true);
  assert.deepEqual(controlledRequests, [[false, "swipe"]]);
  assert.equal(readProp(controlled.popup()["data-swipe-dismiss"]), undefined, "a controlled parent that rejects closing snaps back");
  controlled.dispose();

  const optionalArea = createDrawer({ id: "optional-swipe-area", swipeThreshold: 20 });
  const disabledArea = optionalArea.swipeArea({ disabled: true });
  performPointerSwipe(disabledArea, { axis: "y", start: 100, end: 50, startTime: 0, endTime: 10 });
  assert.equal(optionalArea.open.value, false);
  assert.equal(readProp(disabledArea["data-disabled"]), "");
  const rightOpeningArea = optionalArea.swipeArea({ swipeDirection: "right" });
  assert.equal(rightOpeningArea["data-swipe-direction"], "right");
  performPointerSwipe(rightOpeningArea, { axis: "x", start: 0, end: 30, startTime: 20, endTime: 30 });
  assert.equal(optionalArea.open.value, true, "a swipe area can override its physical opening direction");
  optionalArea.dispose();
  await Promise.resolve();
});

test("drawer CSS movement and snap offsets follow every physical swipe direction", () => {
  const cases = [
    { swipeDirection: "down", axis: "y", start: 100, end: 120, movement: "20px", offset: "200px" },
    { swipeDirection: "up", axis: "y", start: 100, end: 80, movement: "-20px", offset: "-200px" },
    { swipeDirection: "right", axis: "x", start: 100, end: 120, movement: "20px", offset: "200px" },
    { swipeDirection: "left", axis: "x", start: 100, end: 80, movement: "-20px", offset: "-200px" },
  ];
  for (const entry of cases) {
    const drawer = createDrawer({
      id: `direction-${entry.swipeDirection}`,
      defaultOpen: true,
      swipeDirection: entry.swipeDirection,
      snapPoints: ["100px", 1],
    });
    drawer.measure({ viewportSize: 300, popupSize: 300 });
    const popup = drawer.popup();
    const target = pointerTarget();
    popup.onPointerDown(pointerEvent({
      pointerId: 41,
      clientX: entry.axis === "x" ? entry.start : 0,
      clientY: entry.axis === "y" ? entry.start : 0,
      timeStamp: 0,
      currentTarget: target,
    }));
    popup.onPointerMove(pointerEvent({
      pointerId: 41,
      clientX: entry.axis === "x" ? entry.end : 0,
      clientY: entry.axis === "y" ? entry.end : 0,
      timeStamp: 1000,
    }));
    assert.equal(styleValue(popup, `--drawer-swipe-movement-${entry.axis}`), entry.movement);
    assert.equal(styleValue(popup, "--drawer-snap-point-offset"), entry.offset);
    assert.equal(readProp(popup["data-swipe-direction"]), entry.swipeDirection);
    popup.onPointerCancel(pointerEvent({ pointerId: 41 }));
    drawer.dispose();
  }
});

test("drawer rejects invalid snap configuration and measurements", () => {
  for (const snapPoint of [-1, Number.NaN, Number.POSITIVE_INFINITY, "50%", " 10px", "calc(1px)"]) {
    assert.throws(() => createDrawer({ id: "invalid-snap", snapPoints: [snapPoint] }), /snapPoints\[0\]/);
  }
  assert.throws(
    () => createDrawer({ id: "invalid-default", snapPoints: [0.5, 1], defaultSnapPoint: 0.75 }),
    /one of the configured snapPoints/,
  );
  assert.throws(
    () => createDrawer({ id: "invalid-controlled", snapPoint: 0.5 }),
    /one of the configured snapPoints/,
  );
  const drawer = createDrawer({ id: "invalid-measurement" });
  assert.throws(() => drawer.measure({ viewportSize: -1 }), /non-negative finite number/);
  assert.throws(() => drawer.measure({ popupSize: Number.NaN }), /non-negative finite number/);
  assert.throws(() => drawer.measure({ rootFontSize: 0 }), /positive finite number/);
  drawer.dispose();
});

test("drawer parts automatically measure their own DOM realm and release observers", () => {
  const observed = [];
  const listeners = new Map();
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; observed.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  class FakeElement {
    constructor(document, { width, height }) {
      this.ownerDocument = document;
      this.clientWidth = width;
      this.clientHeight = height;
      this.offsetWidth = width;
      this.offsetHeight = height;
    }
    addEventListener() {}
    removeEventListener() {}
    getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight }; }
  }
  const view = {
    HTMLElement: FakeElement,
    Node: FakeElement,
    ResizeObserver: FakeResizeObserver,
    innerWidth: 800,
    innerHeight: 600,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    getComputedStyle() {
      return { fontSize: "20px", transitionDuration: "0s", transitionDelay: "0s", animationDuration: "0s", animationDelay: "0s" };
    },
  };
  const document = {
    activeElement: null,
    documentElement: { clientWidth: 800, clientHeight: 600 },
    defaultView: view,
    addEventListener() {},
    removeEventListener() {},
  };
  const viewport = new FakeElement(document, { width: 800, height: 600 });
  const popup = new FakeElement(document, { width: 500, height: 500 });
  const drawer = createDrawer({ id: "measured-sheet", modal: false, snapPoints: ["5rem", 1] });
  const cleanupViewport = drawer.viewport().use(viewport);
  const cleanupPopup = drawer.popup().use(popup);
  assert.deepEqual(drawer.resolvedSnapPoints.value, [
    { value: "5rem", size: 100, offset: 400 },
    { value: 1, size: 500, offset: 0 },
  ]);
  popup.clientHeight = 400;
  popup.offsetHeight = 400;
  observed.forEach((observer) => observer.callback());
  assert.equal(drawer.snapPointOffset.value, 300);
  drawer.dispose();
  assert.ok(observed.every((observer) => observer.disconnected), "controller disposal releases its measurement observers");
  cleanupPopup();
  cleanupViewport();
});

test("drawer virtual keyboard provider uses the mounted element realm and cleans up", () => {
  const listeners = new Map();
  const visualViewport = {
    height: 500,
    offsetTop: 0,
    addEventListener(name, listener) { listeners.set(`viewport:${name}`, listener); },
    removeEventListener(name) { listeners.delete(`viewport:${name}`); },
  };
  const window = {
    innerHeight: 800,
    visualViewport,
    addEventListener(name, listener) { listeners.set(`window:${name}`, listener); },
    removeEventListener(name) { listeners.delete(`window:${name}`); },
  };
  const keyboard = createDrawerVirtualKeyboardProvider({ id: "keyboard" });
  const cleanup = keyboard.provider().use({ ownerDocument: { defaultView: window } });
  assert.equal(keyboard.inset.value, 300);
  assert.equal(keyboard.provider()["data-keyboard-open"](), "");
  cleanup();
  assert.equal(keyboard.inset.value, 0);
  assert.equal(listeners.size, 0);
  keyboard.dispose();
});

function basicEvent(overrides = {}) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...overrides };
}

function pointerEvent(overrides = {}) {
  return basicEvent({
    pointerType: "touch",
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 0,
    clientY: 0,
    target: null,
    composedPath: () => [],
    ...overrides,
  });
}

function pointerTarget() {
  return {
    captured: new Set(),
    setPointerCapture(pointerId) { this.captured.add(pointerId); },
    releasePointerCapture(pointerId) { this.captured.delete(pointerId); },
  };
}

function performPointerSwipe(props, { axis, start, end, startTime, endTime }) {
  const target = pointerTarget();
  props.onPointerDown(pointerEvent({
    pointerId: 23,
    clientX: axis === "x" ? start : 0,
    clientY: axis === "y" ? start : 0,
    timeStamp: startTime,
    currentTarget: target,
  }));
  props.onPointerMove(pointerEvent({
    pointerId: 23,
    clientX: axis === "x" ? end : 0,
    clientY: axis === "y" ? end : 0,
    timeStamp: endTime,
  }));
  props.onPointerUp(pointerEvent({
    pointerId: 23,
    clientX: axis === "x" ? end : 0,
    clientY: axis === "y" ? end : 0,
    timeStamp: endTime,
  }));
}

function readProp(value) {
  return typeof value === "function" ? value() : value;
}

function styleValue(props, name) {
  const style = readProp(props.style);
  return readProp(style[name]);
}
