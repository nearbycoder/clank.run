import test from "node:test";
import assert from "node:assert/strict";
import { signal } from "../dist/core.js";
import { createFloating, createOverlay, createPresence } from "../dist/ui-overlay.js";
import { createDialog, createDrawer, createPopover } from "../dist/ui-popups.js";

test("floating positioning flips, shifts, and exposes arrow and available-space state", () => {
  const listeners = new Map();
  const view = {
    innerWidth: 320,
    innerHeight: 240,
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const document = {
    defaultView: view,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const anchor = { getBoundingClientRect: () => ({ left: 120, right: 160, top: 210, bottom: 230, width: 40, height: 20 }) };
  const element = {
    ownerDocument: document,
    offsetParent: null,
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 80, width: 100, height: 80 }),
  };
  const floating = createFloating({ anchor, side: "bottom", sideOffset: 8, collisionPadding: 10 });
  const cleanup = floating.positioner().use(element);
  floating.update();

  assert.equal(floating.side.value, "top");
  assert.equal(floating.y.value, 122);
  assert.equal(floating.x.value, 90);
  assert.equal(floating.arrowX.value, 50);
  assert.equal(floating.availableWidth.value, 300);
  cleanup();
});

test("presence retains ending content until completion", async () => {
  const visible = signal(true);
  let exits = 0;
  const presence = createPresence({ present: visible, onExitComplete: () => exits++ });
  assert.equal(presence.mounted.value, true);
  visible.value = false;
  assert.equal(presence.state.value, "ending");
  await Promise.resolve();
  assert.equal(presence.mounted.value, false);
  assert.equal(presence.state.value, "closed");
  assert.equal(exits, 1);
  presence.dispose();
});

test("only the topmost overlay handles Escape", async () => {
  const listeners = new Map();
  class FakeHTMLElement {
    constructor(document) {
      this.ownerDocument = document;
      this.isConnected = true;
      this.hidden = false;
      this.attributes = new Map();
    }
    querySelectorAll() { return []; }
    contains(value) { return value === this; }
    closest() { return null; }
    matches() { return false; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getClientRects() { return [{}]; }
    focus() { this.ownerDocument.activeElement = this; }
  }
  const document = {
    activeElement: null,
    body: { style: { overflow: "", paddingRight: "" }, children: [] },
    documentElement: { clientWidth: 800 },
    defaultView: { HTMLElement: FakeHTMLElement, Node: FakeHTMLElement, innerWidth: 800 },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const firstOpen = signal(true);
  const secondOpen = signal(true);
  const dismissed = [];
  const first = createOverlay({ open: firstOpen, onDismiss: (reason) => { dismissed.push(["first", reason]); firstOpen.value = false; } });
  const second = createOverlay({ open: secondOpen, onDismiss: (reason) => { dismissed.push(["second", reason]); secondOpen.value = false; } });
  const cleanupFirst = first.content().use(new FakeHTMLElement(document));
  const cleanupSecond = second.content().use(new FakeHTMLElement(document));
  await Promise.resolve();
  const escape = () => listeners.get("keydown")({ key: "Escape", preventDefault() {}, defaultPrevented: false });
  escape();
  assert.deepEqual(dismissed, [["second", "escape-key"]]);
  escape();
  assert.deepEqual(dismissed, [["second", "escape-key"], ["first", "escape-key"]]);
  cleanupSecond();
  cleanupFirst();
});

test("an overlay can retain input focus and treats its trigger as inside for pointer dismissal", async () => {
  const { document, listeners, Element } = fakeOverlayDocument();
  const open = signal(true);
  const trigger = new Element(document, "input");
  const popup = new Element(document, "div");
  const outside = new Element(document, "button");
  document.body.append(trigger, popup, outside);
  document.activeElement = trigger;
  const dismissals = [];
  const overlay = createOverlay({
    open,
    trigger: () => trigger,
    autoFocus: false,
    onDismiss(reason) { dismissals.push(reason); open.value = false; },
  });
  overlay.content().use(popup);
  await Promise.resolve();
  assert.equal(document.activeElement, trigger, "mounting must not steal focus from an editable trigger");

  listeners.get("pointerdown")({
    target: trigger,
    composedPath: () => [trigger, document.body, document],
    defaultPrevented: false,
  });
  assert.deepEqual(dismissals, [], "the opening trigger belongs to its overlay pointer boundary");

  listeners.get("pointerdown")({
    target: outside,
    composedPath: () => [outside, document.body, document],
    defaultPrevented: false,
  });
  assert.deepEqual(dismissals, ["outside-press"]);
  await Promise.resolve();
  assert.equal(document.activeElement, trigger, "outside press dismissal must not steal focus back later");
  overlay.dispose();
});

test("a canceled dismissal cannot suppress focus restoration for a later programmatic close", async () => {
  const { document, Element } = fakeOverlayDocument();
  const open = signal(true);
  const trigger = new Element(document, "button");
  const popup = new Element(document, "div");
  const outside = new Element(document, "button");
  document.body.append(trigger, popup, outside);
  document.activeElement = trigger;
  const overlay = createOverlay({
    open,
    trigger: () => trigger,
    autoFocus: false,
    onDismiss() {
      // Keeping `open` true models cancellation by the owning controllable state.
    },
  });
  overlay.content().use(popup);
  overlay.dismiss("outside-press");
  assert.equal(open.value, true);

  document.activeElement = outside;
  open.value = false;
  await Promise.resolve();
  assert.equal(document.activeElement, trigger, "the unrelated accepted close restores focus");
  overlay.dispose();
});

test("nonmodal popup families dismiss on external focus unless pointer dismissal is disabled", () => {
  const families = [
    ["Popover", (id, options = {}) => createPopover({ id, modal: false, defaultOpen: true, ...options })],
    ["Dialog", (id, options = {}) => createDialog({ id, modal: false, defaultOpen: true, ...options })],
    ["Drawer", (id, options = {}) => createDrawer({ id, modal: false, defaultOpen: true, ...options })],
  ];

  for (const [name, create] of families) {
    const { document, listeners, Element } = fakeOverlayDocument();
    const trigger = new Element(document, "button");
    const popup = new Element(document, "div");
    const outside = new Element(document, "button");
    document.body.append(trigger, popup, outside);
    const controller = create(`focus-out-${name.toLowerCase()}`);
    controller.trigger().ref(trigger);
    controller.popup().use(popup);
    listeners.get("focusin")({
      target: outside,
      relatedTarget: popup,
      composedPath: () => [outside, document.body, document],
      defaultPrevented: false,
    });
    assert.equal(controller.open.value, false, `${name} closes on focus-out when nonmodal`);
    controller.dispose();
  }

  const disabledCases = [
    ["Popover", (id) => createPopover({ id, modal: false, defaultOpen: true, closeOnOutsidePress: false })],
    ["Dialog", (id) => createDialog({ id, modal: false, defaultOpen: true, closeOnOutsidePress: false })],
    ["Drawer", (id) => createDrawer({ id, modal: false, defaultOpen: true, disablePointerDismissal: true })],
  ];
  for (const [name, create] of disabledCases) {
    const { document, listeners, Element } = fakeOverlayDocument();
    const trigger = new Element(document, "button");
    const popup = new Element(document, "div");
    const outside = new Element(document, "button");
    document.body.append(trigger, popup, outside);
    const controller = create(`focus-out-disabled-${name.toLowerCase()}`);
    controller.trigger().ref(trigger);
    controller.popup().use(popup);
    listeners.get("focusin")({
      target: outside,
      relatedTarget: popup,
      composedPath: () => [outside, document.body, document],
      defaultPrevented: false,
    });
    assert.equal(controller.open.value, true, `${name} retains focus-out when pointer dismissal is disabled`);
    controller.dispose();
  }
});

test("every mounted popup trigger belongs to the overlay press boundary", () => {
  const { document, listeners, Element } = fakeOverlayDocument();
  const firstElement = new Element(document, "button");
  const secondElement = new Element(document, "button");
  const popupElement = new Element(document, "div");
  document.body.append(firstElement, secondElement, popupElement);
  const popover = createPopover({ id: "multi-trigger-boundary" });
  const first = popover.trigger();
  const second = popover.trigger();
  first.ref(firstElement);
  second.ref(secondElement);
  popover.popup().use(popupElement);
  first.onClick({ currentTarget: firstElement, defaultPrevented: false });
  assert.equal(popover.open.value, true);

  listeners.get("pointerdown")({
    target: secondElement,
    composedPath: () => [secondElement, document.body, document],
    defaultPrevented: false,
  });
  assert.equal(popover.open.value, true, "the inactive trigger is not treated as an outside press");
  second.onPointerDown({ currentTarget: secondElement, pointerType: "mouse" });
  second.onClick({ currentTarget: secondElement, defaultPrevented: false });
  assert.equal(popover.open.value, true);
  assert.equal(popover.triggerElement.value, secondElement);
  popover.dispose();
});

test("modal popup triggers stay inert and outside the trapped focus scope", () => {
  const { document, listeners, Element } = fakeOverlayDocument();
  const firstTrigger = new Element(document, "button");
  const secondTrigger = new Element(document, "button");
  const popup = new Element(document, "div");
  const cancel = new Element(document, "button");
  const confirm = new Element(document, "button");
  popup.append(cancel, confirm);
  popup.querySelectorAll = () => [cancel, confirm];
  document.body.append(firstTrigger, secondTrigger, popup);

  const dialog = createDialog({ id: "modal-trigger-boundary", defaultOpen: true, autoFocus: false });
  dialog.trigger().ref(firstTrigger);
  dialog.trigger().ref(secondTrigger);
  dialog.popup().use(popup);

  assert.equal(firstTrigger.hasAttribute("inert"), true, "the active trigger remains modal background");
  assert.equal(secondTrigger.hasAttribute("inert"), true, "inactive triggers remain modal background");
  assert.equal(popup.hasAttribute("inert"), false);

  document.activeElement = cancel;
  let prevented = false;
  listeners.get("keydown")({
    key: "Tab",
    shiftKey: true,
    preventDefault() { prevented = true; },
    defaultPrevented: false,
  });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, confirm, "Shift+Tab wraps to the final dialog control, not a trigger");

  document.activeElement = secondTrigger;
  listeners.get("focusin")({
    target: secondTrigger,
    relatedTarget: confirm,
    composedPath: () => [secondTrigger, document.body, document],
    defaultPrevented: false,
  });
  assert.equal(document.activeElement, cancel, "focus reaching an inert trigger is contained by the modal");

  listeners.get("pointerdown")({
    target: secondTrigger,
    composedPath: () => [secondTrigger, document.body, document],
    defaultPrevented: false,
  });
  assert.equal(dialog.open.value, true, "all triggers still belong to the outside-press boundary");

  dialog.dispose();
  assert.equal(firstTrigger.hasAttribute("inert"), false);
  assert.equal(secondTrigger.hasAttribute("inert"), false);
});

test("modal inerting reaches siblings inside a shared application root and restores them", () => {
  const { document, Element } = fakeOverlayDocument();
  const app = new Element(document, "main");
  const sibling = new Element(document, "section");
  const popup = new Element(document, "div");
  const external = new Element(document, "footer");
  app.append(sibling, popup);
  document.body.append(app, external);
  const overlay = createOverlay({ open: true, modal: true, autoFocus: false, onDismiss() {} });
  const cleanup = overlay.content().use(popup);
  assert.equal(sibling.hasAttribute("inert"), true);
  assert.equal(external.hasAttribute("inert"), true);
  assert.equal(app.hasAttribute("inert"), false, "the app root itself remains traversable to the popup");
  assert.equal(popup.hasAttribute("inert"), false);
  cleanup();
  assert.equal(sibling.hasAttribute("inert"), false);
  assert.equal(external.hasAttribute("inert"), false);
  overlay.dispose();
});

test("modal backdrops stay interactive siblings and retain their dismissal policy", () => {
  const { document, Element } = fakeOverlayDocument();
  const portal = new Element(document, "div");
  const backdrop = new Element(document, "div");
  const popup = new Element(document, "div");
  const background = new Element(document, "main");
  portal.append(backdrop, popup);
  document.body.append(background, portal);
  const reasons = [];
  const overlay = createOverlay({ open: true, modal: true, autoFocus: false, onDismiss(reason) { reasons.push(reason); } });
  const backdropProps = overlay.backdrop();
  const cleanupBackdrop = backdropProps.use(backdrop);
  const cleanupPopup = overlay.content().use(popup);

  assert.equal(backdrop.hasAttribute("inert"), false);
  assert.equal(background.hasAttribute("inert"), true);
  backdropProps.onPointerDown({ target: backdrop, currentTarget: backdrop });
  assert.deepEqual(reasons, ["backdrop-press"]);

  cleanupPopup();
  cleanupBackdrop();
  assert.equal(background.hasAttribute("inert"), false);
  overlay.dispose();
});

test("modal inerting tracks dynamically added siblings and restores their exact prior state", () => {
  const { document, Element } = fakeOverlayDocument();
  let mutate = () => {};
  let disconnected = false;
  document.defaultView.MutationObserver = class {
    constructor(callback) { mutate = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  const popup = new Element(document, "div");
  const existing = new Element(document, "aside");
  existing.setAttribute("inert", "");
  existing.setAttribute("aria-hidden", "false");
  document.body.append(existing, popup);
  const overlay = createOverlay({ open: true, modal: true, autoFocus: false, onDismiss() {} });
  const cleanup = overlay.content().use(popup);
  assert.equal(existing.getAttribute("aria-hidden"), "true");

  const dynamic = new Element(document, "section");
  dynamic.setAttribute("aria-hidden", "false");
  document.body.append(dynamic);
  mutate([]);
  assert.equal(dynamic.hasAttribute("inert"), true, "new siblings become inert without reopening the modal");
  assert.equal(dynamic.getAttribute("aria-hidden"), "true");

  cleanup();
  assert.equal(disconnected, true);
  assert.equal(existing.hasAttribute("inert"), true, "a pre-existing inert attribute is retained");
  assert.equal(existing.getAttribute("aria-hidden"), "false");
  assert.equal(dynamic.hasAttribute("inert"), false);
  assert.equal(dynamic.getAttribute("aria-hidden"), "false");
  overlay.dispose();
});

test("declarative overlay branches participate in modal and interaction boundaries", () => {
  const { document, Element } = fakeOverlayDocument();
  const popup = new Element(document, "div");
  const portal = new Element(document, "div");
  const outside = new Element(document, "main");
  document.body.append(popup, portal, outside);
  const overlay = createOverlay({ open: true, modal: true, autoFocus: false, onDismiss() {} });
  const unregister = overlay.branchProps().use(portal);
  const cleanup = overlay.content().use(popup);
  assert.equal(overlay.branchProps()["data-clank-overlay-branch"], "");
  assert.equal(portal.hasAttribute("inert"), false, "a portaled branch remains interactive");
  assert.equal(outside.hasAttribute("inert"), true);
  unregister();
  assert.equal(portal.hasAttribute("inert"), true, "unregistering immediately restores the modal boundary");
  cleanup();
  assert.equal(portal.hasAttribute("inert"), false);
  overlay.dispose();
});

test("nested modal inert restoration keeps the parent boundary active", () => {
  const { document, Element } = fakeOverlayDocument();
  const parentPopup = new Element(document, "div");
  const childPopup = new Element(document, "div");
  const background = new Element(document, "main");
  background.setAttribute("aria-hidden", "false");
  document.body.append(parentPopup, childPopup, background);
  const parent = createOverlay({ open: true, modal: true, autoFocus: false, onDismiss() {} });
  const cleanupParent = parent.content().use(parentPopup);
  const child = createOverlay({ open: true, modal: true, autoFocus: false, onDismiss() {} });
  const cleanupChild = child.content().use(childPopup);
  assert.equal(childPopup.hasAttribute("inert"), false, "a nested portaled layer is registered with its parent automatically");
  assert.equal(parentPopup.hasAttribute("inert"), true);
  assert.equal(background.hasAttribute("inert"), true);
  cleanupChild();
  assert.equal(parentPopup.hasAttribute("inert"), false);
  assert.equal(background.hasAttribute("inert"), true, "closing the child must retain the parent modal boundary");
  cleanupParent();
  assert.equal(background.hasAttribute("inert"), false);
  assert.equal(background.getAttribute("aria-hidden"), "false");
  child.dispose();
  parent.dispose();
});

test("Tab wrapping uses the deepest active element inside an open shadow root", () => {
  const { document, listeners, Element } = fakeOverlayDocument();
  const popup = new Element(document, "div");
  const first = new Element(document, "button");
  const host = new Element(document, "div");
  const shadowLast = new Element(document, "button");
  const shadow = {
    host,
    activeElement: shadowLast,
    children: [shadowLast],
    querySelectorAll() { return [shadowLast]; },
  };
  host.shadowRoot = shadow;
  shadowLast.parentElement = null;
  shadowLast.getRootNode = () => shadow;
  popup.append(first, host);
  document.body.append(popup);
  document.activeElement = host;
  const overlay = createOverlay({ open: true, modal: "trap-focus", autoFocus: false, onDismiss() {} });
  overlay.content().use(popup);
  let prevented = false;
  listeners.get("keydown")({ key: "Tab", shiftKey: false, preventDefault() { prevented = true; }, defaultPrevented: false });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, first, "Tab on the final shadow descendant wraps to the first item");
  overlay.dispose();
});

test("floating positioning uses visual viewport and clipping ancestor intersections", () => {
  const { document, Element } = fakeOverlayDocument();
  const visualListeners = new Map();
  document.defaultView.visualViewport = {
    offsetLeft: 100,
    offsetTop: 50,
    width: 300,
    height: 200,
    addEventListener(name, listener) { visualListeners.set(name, listener); },
    removeEventListener(name) { visualListeners.delete(name); },
  };
  document.defaultView.getComputedStyle = (element) => element.computedStyle ?? {
    overflow: "visible", overflowX: "visible", overflowY: "visible",
  };
  const clipping = new Element(document, "section");
  clipping.computedStyle = { overflow: "hidden", overflowX: "hidden", overflowY: "hidden" };
  clipping.clientWidth = 200;
  clipping.clientHeight = 160;
  clipping.getBoundingClientRect = () => ({ left: 120, right: 320, top: 60, bottom: 220, width: 200, height: 160 });
  const popup = new Element(document, "div");
  popup.getBoundingClientRect = () => ({ left: 0, right: 80, top: 0, bottom: 60, width: 80, height: 60 });
  clipping.append(popup);
  document.body.append(clipping);
  const anchor = {
    contextElement: clipping,
    getBoundingClientRect: () => ({ left: 280, right: 300, top: 180, bottom: 200, width: 20, height: 20 }),
  };
  const floating = createFloating({ anchor, side: "bottom", collisionPadding: 10, arrowPadding: 5 });
  floating.positioner().use(popup);
  const arrow = new Element(document, "span");
  arrow.getBoundingClientRect = () => ({ left: 0, right: 20, top: 0, bottom: 10, width: 20, height: 10 });
  floating.arrow().use(arrow);
  floating.update();
  assert.equal(floating.side.value, "top");
  assert.equal(floating.x.value, 230, "the popup shifts within the clipping ancestor");
  assert.equal(floating.y.value, 120);
  assert.equal(floating.availableWidth.value, 180);
  assert.equal(floating.availableHeight.value, 110);
  assert.equal(floating.arrowX.value, 50, "arrow coordinates include its width and remain relative to the shifted popup");
  assert.deepEqual([...visualListeners.keys()].sort(), ["resize", "scroll"]);
  floating.dispose();
  assert.equal(visualListeners.size, 0);
});

test("floating positioning rebinds observers and updates when a reactive anchor changes", () => {
  const { document, Element } = fakeOverlayDocument();
  const observers = [];
  document.defaultView.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  };
  document.defaultView.getComputedStyle = (element) => element.computedStyle ?? {
    overflow: "visible", overflowX: "visible", overflowY: "visible",
  };
  const firstClip = new Element(document, "section");
  const secondClip = new Element(document, "section");
  for (const clip of [firstClip, secondClip]) {
    clip.computedStyle = { overflow: "hidden", overflowX: "hidden", overflowY: "hidden" };
  }
  const firstAnchor = new Element(document, "button");
  firstAnchor.getBoundingClientRect = () => ({ left: 20, right: 40, top: 10, bottom: 30, width: 20, height: 20 });
  const secondAnchor = new Element(document, "button");
  secondAnchor.getBoundingClientRect = () => ({ left: 200, right: 240, top: 100, bottom: 130, width: 40, height: 30 });
  firstClip.append(firstAnchor);
  secondClip.append(secondAnchor);
  const popup = new Element(document, "div");
  popup.getBoundingClientRect = () => ({ left: 0, right: 60, top: 0, bottom: 40, width: 60, height: 40 });
  document.body.append(firstClip, secondClip, popup);

  const anchor = signal(firstAnchor);
  const floating = createFloating({ anchor: () => anchor.value, side: "bottom", avoidCollisions: false });
  floating.positioner().use(popup);
  const observer = observers[0];
  assert.equal(floating.x.value, 0);
  assert.equal(floating.y.value, 30);
  assert.equal(observer.targets.has(firstAnchor), true);
  assert.equal(observer.targets.has(firstClip), true);

  anchor.value = secondAnchor;
  assert.equal(floating.x.value, 190);
  assert.equal(floating.y.value, 130);
  assert.equal(observer.targets.has(firstAnchor), false, "the prior anchor is no longer observed");
  assert.equal(observer.targets.has(firstClip), false, "the prior clipping chain is no longer observed");
  assert.equal(observer.targets.has(secondAnchor), true);
  assert.equal(observer.targets.has(secondClip), true);
  floating.dispose();
  assert.equal(observer.targets.size, 0);
});

test("absolute floating coordinates account for offset-parent borders, scrolling, and scale", () => {
  const { document, Element } = fakeOverlayDocument();
  const parent = new Element(document, "div");
  parent.offsetWidth = 200;
  parent.offsetHeight = 100;
  parent.clientLeft = 5;
  parent.clientTop = 3;
  parent.scrollLeft = 10;
  parent.scrollTop = 20;
  parent.getBoundingClientRect = () => ({ left: 100, right: 500, top: 50, bottom: 250, width: 400, height: 200 });
  const popup = new Element(document, "div");
  popup.offsetParent = parent;
  popup.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 50, width: 100, height: 50 });
  parent.append(popup);
  document.body.append(parent);
  const anchor = { getBoundingClientRect: () => ({ left: 300, right: 340, top: 200, bottom: 220, width: 40, height: 20 }) };
  const floating = createFloating({ anchor, side: "bottom", strategy: "absolute", avoidCollisions: false });
  floating.positioner().use(popup);
  floating.update();
  assert.equal(floating.x.value, 90);
  assert.equal(floating.y.value, 102);
  assert.equal(floating.arrowX.value, 50, "arrow math remains in popup-local coordinates after conversion");
  floating.dispose();
});

test("presence keeps starting styles through one paint and crosses on the following frame", () => {
  const { document, Element } = fakeOverlayDocument();
  const frames = [];
  let nextFrame = 1;
  document.defaultView.requestAnimationFrame = (callback) => { frames.push(callback); return nextFrame++; };
  document.defaultView.cancelAnimationFrame = () => {};
  const visible = signal(false);
  const presence = createPresence({ present: visible, keepMounted: true });
  const element = new Element(document, "div");
  presence.props().use(element);
  visible.value = true;
  assert.equal(presence.state.value, "starting");
  frames.shift()();
  assert.equal(presence.state.value, "starting", "the first animation frame paints starting styles");
  frames.shift()();
  assert.equal(presence.state.value, "open");
  presence.dispose();
});

test("presence waits for every explicit transition and animation completion", () => {
  const { document, Element } = fakeOverlayDocument();
  document.defaultView.getComputedStyle = () => ({
    transitionProperty: "opacity, transform",
    transitionDuration: "20ms, 40ms",
    transitionDelay: "0ms",
    animationName: "fade, slide",
    animationDuration: "30ms, 10ms",
    animationDelay: "0ms",
    animationIterationCount: "1, 2",
  });
  const visible = signal(true);
  const presence = createPresence({ present: visible });
  const element = new Element(document, "div");
  presence.props().use(element);
  visible.value = false;
  element.emit("transitionend", { propertyName: "opacity" });
  element.emit("animationend", { animationName: "fade" });
  element.emit("transitionend", { propertyName: "transform" });
  assert.equal(presence.state.value, "ending");
  element.emit("animationend", { animationName: "slide" });
  assert.equal(presence.state.value, "closed");
  assert.equal(presence.mounted.value, false);
  presence.dispose();
});

test("presence timeout uses the longest paired CSS motion rather than summing lists", () => {
  const { document, Element } = fakeOverlayDocument();
  document.defaultView.getComputedStyle = () => ({
    transitionProperty: "opacity, transform",
    transitionDuration: "100ms, 200ms",
    transitionDelay: "50ms, 10ms",
    animationName: "fade",
    animationDuration: "50ms",
    animationDelay: "0ms",
    animationIterationCount: "3",
  });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let fallbackDelay = null;
  globalThis.setTimeout = (_callback, delay) => { fallbackDelay = delay; return 1; };
  globalThis.clearTimeout = () => {};
  try {
    const visible = signal(true);
    const presence = createPresence({ present: visible });
    presence.props().use(new Element(document, "div"));
    visible.value = false;
    assert.equal(fallbackDelay, 260, "210ms longest motion plus the 50ms safety margin");
    presence.dispose();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("overlay and floating dispose release document and viewport listeners", () => {
  const { document, listeners, Element } = fakeOverlayDocument();
  const popup = new Element(document, "div");
  document.body.append(popup);
  const overlay = createOverlay({ open: true, autoFocus: false, onDismiss() {} });
  overlay.content().use(popup);
  assert.equal(listeners.has("keydown"), true);
  overlay.dispose();
  assert.equal(listeners.has("keydown"), false);

  const anchor = { getBoundingClientRect: () => ({ left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 }) };
  const floating = createFloating({ anchor });
  floating.positioner().use(popup);
  assert.equal(listeners.has("scroll"), true);
  floating.dispose();
  assert.equal(listeners.has("scroll"), false);
});

function fakeOverlayDocument() {
  const listeners = new Map();
  class FakeElement {
    constructor(document, tagName = "div") {
      this.ownerDocument = document;
      this.tagName = tagName.toUpperCase();
      this.nodeType = 1;
      this.parentElement = null;
      this.children = [];
      this.attributes = new Map();
      this.style = { overflow: "", paddingRight: "" };
      this.eventListeners = new Map();
      this.hidden = false;
      this.isConnected = true;
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    querySelectorAll() { return []; }
    contains(value) { return value === this || this.children.some((child) => child.contains(value)); }
    closest(selector) {
      if (selector === "[inert]" && this.hasAttribute("inert")) return this;
      if (selector === "[hidden]" && this.hasAttribute("hidden")) return this;
      return this.parentElement?.closest(selector) ?? null;
    }
    matches(selector) {
      if (selector === ":disabled") return this.hasAttribute("disabled");
      return selector.includes(this.tagName.toLowerCase()) || selector.includes("[tabindex]") && this.hasAttribute("tabindex");
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getRootNode() { return this.ownerDocument; }
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 40, width: 100, height: 40 }; }
    focus() { this.ownerDocument.activeElement = this; }
    addEventListener(name, listener) {
      const listeners = this.eventListeners.get(name) ?? new Set();
      listeners.add(listener);
      this.eventListeners.set(name, listeners);
    }
    removeEventListener(name, listener) { this.eventListeners.get(name)?.delete(listener); }
    emit(name, details = {}) {
      const event = { target: this, ...details };
      for (const listener of this.eventListeners.get(name) ?? []) listener(event);
    }
  }
  const viewListeners = new Map();
  const view = {
    HTMLElement: FakeElement,
    Node: FakeElement,
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    addEventListener(name, listener) { viewListeners.set(name, listener); },
    removeEventListener(name) { viewListeners.delete(name); },
  };
  const document = {
    nodeType: 9,
    activeElement: null,
    defaultView: view,
    documentElement: { clientWidth: 800 },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  document.body = new FakeElement(document, "body");
  return { document, listeners, viewListeners, Element: FakeElement };
}
