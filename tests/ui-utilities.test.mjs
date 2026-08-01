import test from "node:test";
import assert from "node:assert/strict";
import { effect } from "../dist/core.js";
import {
  createScrollArea,
  createToastManager,
  createToastProvider,
} from "../dist/ui-utilities.js";

test("scroll areas retain native scrolling, measure both axes, and expose Tailwind-ready geometry", () => {
  let resize;
  const document = eventTarget();
  document.defaultView = eventTarget();
  const viewport = scrollElement(document, {
    clientWidth: 200,
    clientHeight: 100,
    scrollWidth: 500,
    scrollHeight: 300,
  });
  const content = scrollElement(document, { width: 500, height: 300 });
  const horizontal = scrollElement(document, { clientWidth: 200, clientHeight: 10 });
  const vertical = scrollElement(document, { clientWidth: 12, clientHeight: 100 });
  const area = createScrollArea({
    id: "inbox-scroll",
    label: "Inbox messages",
    createResizeObserver(callback) {
      resize = callback;
      return { observe() {}, unobserve() {}, disconnect() {} };
    },
  });
  const cleanViewport = area.viewport().use(viewport);
  const cleanContent = area.content().use(content);
  const cleanHorizontal = area.scrollbar("horizontal").use(horizontal);
  const cleanVertical = area.scrollbar("vertical").use(vertical);
  area.measure();

  assert.equal(area.overflowX.value, true);
  assert.equal(area.overflowY.value, true);
  assert.equal(area.maxScrollX.value, 300);
  assert.equal(area.maxScrollY.value, 200);
  assert.equal(area.root()["aria-label"], "Inbox messages");
  assert.equal(area.scrollbar("horizontal")["aria-label"], "Horizontal scrollbar");
  assert.equal(area.scrollbar("vertical")["aria-label"], "Vertical scrollbar");
  assert.equal(area.scrollbar("horizontal", { label: "Message timeline" })["aria-label"], "Message timeline");
  assert.equal(area.scrollbar("vertical", { labelledBy: "message-axis" })["aria-labelledby"], "message-axis");
  assert.equal(area.scrollbar("vertical", { labelledBy: "message-axis" })["aria-label"], undefined);
  assert.equal(area.scrollbar("horizontal").hidden(), false);
  assert.equal(area.scrollbar("horizontal")["aria-disabled"](), undefined);
  assert.equal(area.scrollbar("horizontal")["aria-valuemax"](), 300);
  assert.equal(area.corner().hidden(), false);
  assert.deepEqual([
    area.root()["data-clank-part"],
    area.viewport()["data-clank-part"],
    area.content()["data-clank-part"],
    area.scrollbar("horizontal")["data-clank-part"],
    area.thumb("horizontal")["data-clank-part"],
    area.corner()["data-clank-part"],
  ], ["root", "viewport", "content", "scrollbar", "thumb", "corner"]);
  assert.deepEqual(area.root().style(), {
    "--clank-scroll-area-measurement": 3,
    "--clank-scroll-area-viewport-width": "200px",
    "--clank-scroll-area-viewport-height": "100px",
    "--clank-scroll-area-content-width": "500px",
    "--clank-scroll-area-content-height": "300px",
    "--clank-scroll-area-scroll-x": "0px",
    "--clank-scroll-area-scroll-y": "0px",
    "--clank-scroll-area-corner-width": "12px",
    "--clank-scroll-area-corner-height": "10px",
  });

  area.scrollTo({ left: 90, top: 40 });
  assert.equal(viewport.scrollLeft, 90);
  assert.equal(viewport.scrollTop, 40);
  assert.equal(area.scrollX.value, 90);
  assert.equal(area.scrollY.value, 40);
  const thumbStyle = area.thumb("horizontal").style();
  assert.equal(thumbStyle.touchAction, "none");
  assert.equal(thumbStyle.userSelect, "none");
  assert.equal(thumbStyle.width, "80px");
  assert.match(thumbStyle.transform, /36px/);

  viewport.clientWidth = 500;
  viewport.scrollWidth = 500;
  resize([], {});
  assert.equal(area.overflowX.value, false);
  assert.equal(area.scrollbar("horizontal").hidden(), true);

  cleanVertical();
  cleanHorizontal();
  cleanContent();
  cleanViewport();
  area.dispose();
});

test("scrollbar wheel, keyboard, track scrubbing, and thumb input consume movement only when useful", () => {
  const document = eventTarget();
  document.defaultView = eventTarget();
  const viewport = scrollElement(document, {
    clientWidth: 100,
    clientHeight: 100,
    scrollWidth: 400,
    scrollHeight: 400,
  });
  const track = scrollElement(document, { clientWidth: 100, clientHeight: 10, left: 0, top: 0 });
  const thumb = scrollElement(document, { clientWidth: 25, clientHeight: 10 });
  const area = createScrollArea({ id: "input-scroll", minThumbSize: 10 });
  area.viewport().use(viewport);
  area.scrollbar("horizontal").use(track);
  area.thumb("horizontal").use(thumb);
  area.measure();

  const horizontal = area.scrollbar("horizontal");
  let accessibleOffset = -1;
  const stopAccessibleOffset = effect(() => { accessibleOffset = horizontal["aria-valuenow"](); });
  const wheel = wheelEvent({ deltaX: 30 });
  horizontal.onWheel(wheel);
  assert.equal(wheel.prevented, true);
  assert.equal(area.scrollX.value, 30);
  assert.equal(accessibleOffset, 30, "scrollbar ARIA state tracks controller-driven movement");
  const canceledWheel = wheelEvent({ deltaX: 30, defaultPrevented: true });
  horizontal.onWheel(canceledWheel);
  assert.equal(area.scrollX.value, 30, "pre-canceled input never mutates scroll state");
  const zoomWheel = wheelEvent({ deltaX: 30, ctrlKey: true });
  horizontal.onWheel(zoomWheel);
  assert.equal(area.scrollX.value, 30, "Ctrl+wheel remains reserved for browser zoom");
  assert.equal(zoomWheel.prevented, false);

  area.scrollTo({ left: 300 });
  const chained = wheelEvent({ deltaX: 30 });
  horizontal.onWheel(chained);
  assert.equal(chained.prevented, false, "wheel events chain at the logical edge");

  const home = keyEvent("Home");
  horizontal.onKeyDown(home);
  assert.equal(home.prevented, true);
  assert.equal(area.scrollX.value, 0);
  const end = keyEvent("End");
  horizontal.onKeyDown(end);
  assert.equal(area.scrollX.value, 300);
  assert.equal(accessibleOffset, 300);

  area.scrollTo({ left: 0 });
  const trackPress = pointerEvent({ currentTarget: track, target: track, pointerId: 6, clientX: 90 });
  horizontal.onPointerDown(trackPress);
  assert.equal(area.scrollX.value, 300, "pressing the track scrubs the thumb to the pointer");
  assert.equal(trackPress.prevented, true);
  document.dispatch("pointermove", pointerEvent({ pointerId: 6, clientX: 15 }));
  assert.equal(area.scrollX.value, 0, "the entire track remains draggable after pointer acquisition");
  document.dispatch("pointerup", pointerEvent({ pointerId: 6, clientX: 15 }));
  assert.equal(horizontal.style().touchAction, "none");
  assert.equal(horizontal.style().userSelect, "none");

  area.scrollTo({ left: 0 });
  const thumbProps = area.thumb("horizontal");
  let dragging = false;
  const stopDragging = effect(() => { dragging = thumbProps["data-dragging"]() === ""; });
  thumbProps.onPointerDown(pointerEvent({ currentTarget: thumb, target: thumb, pointerId: 7, clientX: 0 }));
  assert.equal(dragging, true, "thumb drag state updates reactive DOM bindings immediately");
  document.dispatch("pointermove", pointerEvent({ pointerId: 7, clientX: 37.5 }));
  assert.equal(area.scrollX.value, 150);
  document.dispatch("pointerup", pointerEvent({ pointerId: 7, clientX: 37.5 }));
  assert.equal(dragging, false);
  stopDragging();
  stopAccessibleOffset();
  area.dispose();
});

test("scroll areas hide Chromium native scrollbars with one mounted behavioral rule", () => {
  const styles = [];
  const head = {
    appendChild(element) { element.parentNode = this; styles.push(element); return element; },
    removeChild(element) {
      const index = styles.indexOf(element);
      if (index >= 0) styles.splice(index, 1);
      element.parentNode = null;
    },
  };
  const document = eventTarget();
  document.defaultView = eventTarget();
  document.head = head;
  document.documentElement = head;
  document.createElement = () => ({
    attributes: new Map(),
    parentNode: null,
    setAttribute(name, value) { this.attributes.set(name, value); },
    remove() { this.parentNode?.removeChild(this); },
  });
  const firstViewport = scrollElement(document, { clientWidth: 100, clientHeight: 100 });
  const secondViewport = scrollElement(document, { clientWidth: 100, clientHeight: 100 });
  const first = createScrollArea({ id: "webkit-scroll-one" });
  const second = createScrollArea({ id: "webkit-scroll-two" });
  const firstProps = first.viewport();
  assert.equal(firstProps["data-clank-scroll-area-viewport"], "");
  const cleanFirst = firstProps.use(firstViewport);
  const cleanSecond = second.viewport().use(secondViewport);
  assert.equal(styles.length, 1, "viewports in one document share the pseudo-element rule");
  assert.match(styles[0].textContent, /::-webkit-scrollbar\{display:none\}/);
  cleanFirst();
  assert.equal(styles.length, 1);
  cleanSecond();
  assert.equal(styles.length, 0, "the rule is removed after the final viewport unmounts");
  first.dispose();
  second.dispose();
});

test("scroll areas normalize every RTL scrollLeft model and keep physical keys intuitive", () => {
  const cases = [
    ["negative", -80, -120],
    ["positive-ascending", 80, 120],
    ["positive-descending", 220, 180],
  ];
  for (const [behavior, initialRaw, expectedRaw] of cases) {
    const document = eventTarget();
    document.defaultView = eventTarget();
    const viewport = scrollElement(document, {
      clientWidth: 100,
      clientHeight: 50,
      scrollWidth: 400,
      scrollHeight: 50,
      scrollLeft: initialRaw,
    });
    const area = createScrollArea({
      id: `rtl-${behavior}`,
      direction: "rtl",
      rtlScrollBehavior: behavior,
    });
    area.viewport().use(viewport);
    area.measure();
    assert.equal(area.scrollX.value, 80, behavior);
    area.scrollTo({ left: 120 });
    assert.equal(viewport.scrollLeft, expectedRaw, behavior);
    const right = keyEvent("ArrowRight");
    area.scrollbar("horizontal").onKeyDown(right);
    assert.equal(area.scrollX.value, 80, `${behavior} ArrowRight moves physically right`);
    area.dispose();
  }

  const hidden = createScrollArea({ id: "hidden", scrollbarMode: "hidden" });
  assert.equal(hidden.scrollbar("vertical").hidden(), true);
  assert.equal(hidden.scrollbar("vertical")["aria-hidden"](), true);
  const always = createScrollArea({ id: "always", scrollbarMode: "always" });
  assert.equal(always.scrollbar("vertical").hidden(), false);
  assert.equal(always.scrollbar("vertical")["aria-disabled"](), true);
  assert.equal(JSON.parse(JSON.stringify(always.manifest())).protocol, "clank-ui/1");
});

test("toast managers deduplicate stable IDs, enforce the visible limit, and promote FIFO", () => {
  const clock = fakeClock();
  const manager = createToastManager({ id: "alerts", limit: 2, duration: 100, exitDuration: 20, clock });
  const first = manager.add({ title: "First", dedupeKey: "sync" });
  const second = manager.add("Second");
  const third = manager.add("Third");
  assert.deepEqual([first, second, third], ["alerts-1", "alerts-2", "alerts-3"]);
  assert.deepEqual(manager.toasts.value.map((toast) => toast.state), ["starting", "starting", "queued"]);
  clock.flushMicrotasks();
  assert.deepEqual(manager.visible.value.map((toast) => toast.id), [first, second]);
  assert.deepEqual(manager.queued.value.map((toast) => toast.id), [third]);

  assert.equal(manager.add({ title: "First updated", dedupeKey: "sync" }), first);
  assert.equal(manager.toasts.value.length, 3);
  assert.equal(manager.get(first).title, "First updated");
  assert.equal(manager.close(first), true);
  assert.equal(manager.get(first).state, "ending");
  assert.equal(manager.get(third).state, "queued", "ending toasts retain their layout slot");
  clock.advance(20);
  assert.equal(manager.get(first), undefined);
  assert.equal(manager.get(third).state, "open");
  assert.equal(Object.isFrozen(manager.get(third)), true);
  assert.deepEqual(manager.manifest().state, { total: 2, visible: 2, queued: 0, paused: false, limit: 2 });
  manager.dispose();
});

test("toast timers retain exact remaining time across overlapping pause reasons", () => {
  const clock = fakeClock();
  const closed = [];
  const manager = createToastManager({ id: "timed", duration: 100, exitDuration: 10, clock });
  let id;
  id = manager.add({
    title: "Saved",
    onClose: (reason) => closed.push([reason, manager.get(id)?.state ?? "removed"]),
  });
  clock.flushMicrotasks();
  clock.advance(30);
  manager.pause("hover");
  manager.pause("window-blur");
  assert.equal(manager.get(id).paused, true);
  clock.advance(500);
  manager.resume("hover");
  clock.advance(500);
  assert.equal(manager.get(id).state, "open", "one outstanding reason keeps timers paused");
  manager.resume("window-blur");
  clock.advance(69);
  assert.equal(manager.get(id).state, "open");
  clock.advance(1);
  assert.equal(manager.get(id).state, "ending");
  assert.deepEqual(closed, [["timeout", "ending"]], "close callbacks observe the committed transition");
  clock.advance(10);
  assert.equal(manager.get(id), undefined);
  manager.dispose();
});

test("toast promise APIs keep one ID through loading, success, and error", async () => {
  const clock = fakeClock();
  const manager = createToastManager({ id: "work", duration: 50, exitDuration: 0, clock });
  const successful = manager.promise(Promise.resolve(7), {
    loading: "Counting",
    success: (value) => ({ title: `Counted ${value}`, priority: "assertive" }),
    error: "Failed",
  }, { id: "count-job" });
  assert.equal(successful.toastId, "count-job");
  assert.equal(manager.get("count-job").duration, Infinity);
  assert.equal(await successful, 7);
  assert.equal(manager.get("count-job").title, "Counted 7");
  assert.equal(manager.get("count-job").priority, "assertive");
  assert.equal(manager.get("count-job").duration, 50);

  const failed = manager.promise(Promise.reject(new Error("network")), {
    loading: "Sending",
    success: "Sent",
    error: (error) => ({ title: "Could not send", description: error.message }),
  });
  await assert.rejects(failed, /network/);
  assert.equal(manager.get(failed.toastId).title, "Could not send");
  assert.equal(manager.get(failed.toastId).description, "network");
  manager.dispose();
});

test("toast providers coordinate live regions, F6 focus, Shift+Tab restoration, Escape, and window pauses", () => {
  const clock = fakeClock();
  const manager = createToastManager({ id: "provider-store", duration: 100, exitDuration: 0, clock });
  const provider = createToastProvider({ id: "provider", manager });
  const environment = domEnvironment();
  const providerElement = element(environment.document);
  const viewport = element(environment.document);
  const before = element(environment.document);
  before.focus();
  const cleanupProvider = provider.provider().use(providerElement);
  const cleanupViewport = provider.viewport().use(viewport);
  const emptyF6 = keyEvent("F6", { currentTarget: environment.document });
  environment.document.dispatch("keydown", emptyF6);
  assert.equal(emptyF6.prevented, false, "F6 is not claimed when no rendered toast exists");
  assert.equal(environment.document.activeElement, before);
  const id = manager.add({ title: "Session expired", priority: "assertive" });
  clock.flushMicrotasks();
  const root = element(environment.document, { height: 48 });
  const cleanupRoot = provider.root(id).use(root);
  assert.equal(provider.root(id).role(), "alert");
  assert.equal(provider.root(id)["aria-live"](), "assertive");

  const f6 = keyEvent("F6", { currentTarget: environment.document });
  environment.document.dispatch("keydown", f6);
  assert.equal(f6.prevented, true);
  assert.equal(environment.document.activeElement, root);

  const back = keyEvent("Tab", { shiftKey: true, currentTarget: environment.document });
  environment.document.dispatch("keydown", back);
  assert.equal(back.prevented, true);
  assert.equal(environment.document.activeElement, before);

  const focusAgain = keyEvent("F6", { currentTarget: environment.document });
  environment.document.dispatch("keydown", focusAgain);
  assert.equal(environment.document.activeElement, root);
  const escape = keyEvent("Escape", { currentTarget: environment.document });
  environment.document.dispatch("keydown", escape);
  assert.equal(manager.get(id), undefined);
  assert.equal(environment.document.activeElement, before, "dismissing the last F6-focused toast restores prior focus");

  const pausedId = manager.add("Paused");
  clock.flushMicrotasks();
  environment.window.dispatch("blur", event());
  assert.equal(manager.paused.value, true);
  clock.advance(500);
  assert.equal(manager.get(pausedId).state, "open");
  environment.window.dispatch("focus", event());
  assert.equal(manager.paused.value, false);

  cleanupRoot();
  cleanupViewport();
  cleanupProvider();
  provider.dispose();
  manager.dispose();
});

test("toast roots reference only title and description parts that are actually rendered", () => {
  const clock = fakeClock();
  const manager = createToastManager({ id: "aria-store", duration: Infinity, exitDuration: 0, clock });
  const provider = createToastProvider({ id: "aria-provider", manager });
  const environment = domEnvironment();
  const toastId = manager.add({ title: "Saved", description: "The draft is ready." });
  clock.flushMicrotasks();
  const root = provider.root(toastId);
  assert.equal(root["aria-labelledby"](), undefined);
  assert.equal(root["aria-describedby"](), undefined);

  const title = provider.title(toastId);
  const cleanTitle = title.use(element(environment.document));
  assert.equal(root["aria-labelledby"](), `aria-provider-${toastId}-title`);
  assert.equal(root["aria-describedby"](), undefined, "record data alone cannot create a dangling description reference");

  const description = provider.description(toastId);
  const cleanDescription = description.use(element(environment.document));
  assert.equal(root["aria-describedby"](), `aria-provider-${toastId}-description`);
  cleanDescription();
  cleanTitle();
  assert.equal(root["aria-labelledby"](), undefined);
  assert.equal(root["aria-describedby"](), undefined);
  provider.dispose();
  manager.dispose();
});

test("toast actions, stacking variables, anchor metadata, and swipe dismissal stay agent-readable", () => {
  const clock = fakeClock();
  const manager = createToastManager({ id: "interactions", duration: Infinity, exitDuration: 0, clock });
  const provider = createToastProvider({
    id: "interaction-provider",
    manager,
    swipeDirection: "right",
    swipeThreshold: 50,
    swipeVelocity: 99,
    gap: 8,
  });
  const environment = domEnvironment();
  let actions = 0;
  const first = manager.add({
    title: "Undo delete",
    action: { label: "Undo", altText: "Undo deleting the task", onPress: () => actions++ },
    anchor: { id: "task-42", side: "top", align: "end", x: 20, y: 30 },
  });
  const second = manager.add("Second");
  clock.flushMicrotasks();
  const firstRoot = element(environment.document, { height: 40 });
  const secondRoot = element(environment.document, { height: 30 });
  provider.root(first).use(firstRoot);
  provider.root(second).use(secondRoot);
  assert.equal(provider.positioner(second).style()["--clank-toast-offset"], "48px");
  assert.equal(provider.positioner(first)["data-anchor"](), "task-42");
  assert.equal(provider.arrow(first).hidden(), false);
  assert.equal(provider.action(first)["aria-label"](), "Undo deleting the task");
  provider.action(first).onClick(event());
  assert.equal(actions, 1);
  assert.equal(manager.get(first), undefined);

  const swipeRoot = provider.root(second);
  assert.equal(swipeRoot.style().touchAction, "pan-y");
  swipeRoot.onPointerDown(pointerEvent({ currentTarget: secondRoot, target: secondRoot, pointerId: 2, clientX: 0 }));
  swipeRoot.onPointerMove(pointerEvent({ currentTarget: secondRoot, target: secondRoot, pointerId: 2, clientX: 70 }));
  assert.equal(swipeRoot["data-swiping"](), "");
  assert.equal(swipeRoot.style()["--clank-toast-swipe-x"], "70px");
  swipeRoot.onPointerUp(pointerEvent({ currentTarget: secondRoot, target: secondRoot, pointerId: 2, clientX: 70 }));
  assert.equal(manager.get(second), undefined);

  const canceledId = manager.add("Canceled swipe");
  clock.flushMicrotasks();
  const canceledRootElement = element(environment.document, { height: 30 });
  const canceledRoot = provider.root(canceledId);
  canceledRoot.use(canceledRootElement);
  canceledRoot.onPointerDown(pointerEvent({ currentTarget: canceledRootElement, target: canceledRootElement, pointerId: 3, clientX: 0 }));
  canceledRoot.onPointerMove(pointerEvent({ currentTarget: canceledRootElement, target: canceledRootElement, pointerId: 3, clientX: 70 }));
  canceledRoot.onPointerCancel(pointerEvent({ currentTarget: canceledRootElement, target: canceledRootElement, pointerId: 3, clientX: 70 }));
  assert.ok(manager.get(canceledId), "pointer cancellation rolls back instead of dismissing");
  assert.equal(canceledRoot.style()["--clank-toast-swipe-x"], "0px");

  const manifestId = manager.add({ title: "Agent toast", action: { label: "Open" } });
  clock.flushMicrotasks();
  const manifest = provider.manifest(manifestId);
  assert.equal(manifest.protocol, "clank-ui/1");
  assert.deepEqual(manifest.actions.map((action) => action.name), ["close", "action"]);
  assert.doesNotThrow(() => JSON.stringify(manifest));
  assert.deepEqual([
    provider.provider()["data-clank-part"],
    provider.portal()["data-clank-part"],
    provider.viewport()["data-clank-part"],
    provider.positioner(manifestId)["data-clank-part"],
    provider.root(manifestId)["data-clank-part"],
    provider.content(manifestId)["data-clank-part"],
    provider.title(manifestId)["data-clank-part"],
    provider.description(manifestId)["data-clank-part"],
    provider.action(manifestId)["data-clank-part"],
    provider.close(manifestId)["data-clank-part"],
    provider.arrow(manifestId)["data-clank-part"],
  ], ["provider", "portal", "viewport", "positioner", "root", "content", "title", "description", "action", "close", "arrow"]);
  provider.dispose();
  manager.dispose();
});

test("toast swipe starts only from non-interactive, non-ignored descendants", () => {
  const clock = fakeClock();
  const manager = createToastManager({ id: "swipe-ignore", duration: Infinity, exitDuration: 0, clock });
  const provider = createToastProvider({
    id: "swipe-ignore-provider",
    manager,
    swipeDirection: "right",
    swipeThreshold: 20,
    swipeVelocity: 99,
  });
  const environment = domEnvironment();
  const toastId = manager.add("Keep interactive content usable");
  clock.flushMicrotasks();
  const rootElement = element(environment.document, { height: 30 });
  const root = provider.root(toastId);
  root.use(rootElement);

  const button = { matches(selector) { return selector.includes("button"); } };
  rootElement.children.add(button);
  root.onPointerDown(pointerEvent({
    currentTarget: rootElement,
    target: button,
    pointerId: 11,
    composedPath() { return [button, rootElement]; },
  }));
  root.onPointerMove(pointerEvent({ currentTarget: rootElement, target: button, pointerId: 11, clientX: 40 }));
  assert.equal(root["data-swiping"](), undefined);
  assert.equal(root.style()["--clank-toast-swipe-x"], "0px");

  const ignored = {
    matches(selector) { return selector.includes("[data-base-ui-swipe-ignore]"); },
  };
  rootElement.children.add(ignored);
  root.onPointerDown(pointerEvent({
    currentTarget: rootElement,
    target: ignored,
    pointerId: 12,
    composedPath() { return [ignored, rootElement]; },
  }));
  root.onPointerMove(pointerEvent({ currentTarget: rootElement, target: ignored, pointerId: 12, clientX: 40 }));
  assert.equal(root["data-swiping"](), undefined);

  const content = { matches() { return false; } };
  rootElement.children.add(content);
  root.onPointerDown(pointerEvent({
    currentTarget: rootElement,
    target: content,
    pointerId: 13,
    composedPath() { return [content, rootElement]; },
  }));
  root.onPointerMove(pointerEvent({ currentTarget: rootElement, target: content, pointerId: 13, clientX: 10 }));
  assert.equal(root["data-swiping"](), "");
  root.onPointerCancel(pointerEvent({ currentTarget: rootElement, target: content, pointerId: 13, clientX: 10 }));

  provider.dispose();
  manager.dispose();
});

test("toast root cleanup and lost pointer capture always release swipe pauses", () => {
  const clock = fakeClock();
  const manager = createToastManager({ id: "swipe-cleanup", duration: Infinity, exitDuration: 0, clock });
  const provider = createToastProvider({
    id: "swipe-cleanup-provider",
    manager,
    swipeDirection: "right",
    swipeThreshold: 50,
    swipeVelocity: 99,
  });
  const environment = domEnvironment();
  const toastId = manager.add("Release every swipe pause");
  clock.flushMicrotasks();
  const released = [];
  const rootElement = Object.assign(element(environment.document, { height: 30 }), {
    releasePointerCapture(pointerId) { released.push(pointerId); },
  });
  const root = provider.root(toastId);
  const cleanup = root.use(rootElement);

  root.onPointerDown(pointerEvent({ currentTarget: rootElement, target: rootElement, pointerId: 21 }));
  root.onPointerMove(pointerEvent({ currentTarget: rootElement, target: rootElement, pointerId: 21, clientX: 15 }));
  assert.equal(manager.paused.value, true);
  cleanup();
  assert.equal(manager.paused.value, false);
  assert.equal(root["data-swiping"](), undefined);
  assert.deepEqual(released, [21]);

  const nextElement = Object.assign(element(environment.document, { height: 30 }), {
    releasePointerCapture(pointerId) { released.push(pointerId); },
  });
  const nextRoot = provider.root(toastId);
  const cleanupNext = nextRoot.use(nextElement);
  nextRoot.onPointerDown(pointerEvent({ currentTarget: nextElement, target: nextElement, pointerId: 22 }));
  assert.equal(manager.paused.value, true);
  nextRoot.onLostPointerCapture(pointerEvent({ currentTarget: nextElement, target: nextElement, pointerId: 99 }));
  assert.equal(manager.paused.value, true, "an unrelated capture loss does not cancel the active pointer");
  nextRoot.onLostPointerCapture(pointerEvent({ currentTarget: nextElement, target: nextElement, pointerId: 22 }));
  assert.equal(manager.paused.value, false);
  assert.equal(nextRoot["data-swiping"](), undefined);
  assert.equal(nextRoot.style()["--clank-toast-swipe-x"], "0px");
  assert.deepEqual(released, [21, 22]);

  cleanupNext();
  provider.dispose();
  manager.dispose();
});

function fakeClock() {
  let now = 0;
  let serial = 0;
  const timers = new Map();
  const microtasks = [];
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++serial;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    queueMicrotask(callback) { microtasks.push(callback); },
    flushMicrotasks() {
      while (microtasks.length > 0) microtasks.shift()();
    },
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        this.flushMicrotasks();
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
      this.flushMicrotasks();
    },
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, listener) {
      const entries = listeners.get(name) ?? new Set();
      entries.add(listener);
      listeners.set(name, entries);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name, value = event()) {
      if (value.currentTarget == null) value.currentTarget = this;
      for (const listener of [...(listeners.get(name) ?? [])]) listener(value);
    },
  };
}

function domEnvironment() {
  const window = eventTarget();
  let now = 0;
  window.performance = { now: () => now++ };
  const document = eventTarget();
  document.nodeType = 9;
  document.activeElement = null;
  document.hidden = false;
  document.defaultView = window;
  document.documentElement = {};
  window.document = document;
  return { window, document };
}

function element(document, dimensions = {}) {
  return {
    ownerDocument: document,
    isConnected: true,
    offsetHeight: dimensions.height ?? 0,
    children: new Set(),
    contains(target) { return target === this || this.children.has(target); },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: dimensions.width ?? 0, height: dimensions.height ?? 0 };
    },
    focus() { document.activeElement = this; },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

function scrollElement(document, dimensions = {}) {
  const target = eventTarget();
  return Object.assign(target, element(document, dimensions), {
    clientWidth: dimensions.clientWidth ?? dimensions.width ?? 0,
    clientHeight: dimensions.clientHeight ?? dimensions.height ?? 0,
    scrollWidth: dimensions.scrollWidth ?? dimensions.width ?? 0,
    scrollHeight: dimensions.scrollHeight ?? dimensions.height ?? 0,
    scrollLeft: dimensions.scrollLeft ?? 0,
    scrollTop: dimensions.scrollTop ?? 0,
    scrollTo(position) {
      if (position.left !== undefined) this.scrollLeft = position.left;
      if (position.top !== undefined) this.scrollTop = position.top;
    },
  });
}

function event(overrides = {}) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; this.prevented = true; },
    ...overrides,
  };
}

function keyEvent(key, overrides = {}) {
  return event({ key, prevented: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...overrides });
}

function pointerEvent(overrides = {}) {
  return event({
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    currentTarget: null,
    target: null,
    ...overrides,
  });
}

function wheelEvent(overrides = {}) {
  return event({ deltaX: 0, deltaY: 0, prevented: false, ...overrides });
}
