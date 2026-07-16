import test from "node:test";
import assert from "node:assert/strict";
import {
  createDialog,
  createDisclosure,
  createPagination,
  createTabs,
  signal,
} from "../dist/index.js";

test("disclosures expose reactive accessible trigger and panel state", () => {
  const disclosure = createDisclosure({ id: "filters" });
  const trigger = disclosure.trigger({ agentId: "toggle-filters" });
  const panel = disclosure.panel({ role: "region" });

  assert.equal(trigger["aria-expanded"](), false);
  assert.equal(panel.hidden(), true);
  trigger.onClick();
  assert.equal(trigger["aria-expanded"](), true);
  assert.equal(panel.hidden(), false);
  disclosure.hide();
  assert.equal(disclosure.open.value, false);
});

test("dialogs trap initial focus, close on Escape, restore focus, and unlock scrolling", async () => {
  const listeners = new Map();
  const document = {
    activeElement: null,
    body: { style: { overflow: "auto" } },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const trigger = {
    isConnected: true,
    hasAttribute: () => false,
    focus() { document.activeElement = this; },
  };
  const first = {
    focus() { document.activeElement = this; },
    hasAttribute: () => false,
    getAttribute: () => null,
  };
  const element = {
    ownerDocument: document,
    querySelectorAll: () => [first],
    focus() { document.activeElement = this; },
  };
  const dialog = createDialog({ id: "checkout" });
  const props = dialog.dialog();
  const cleanup = props.use(element);

  dialog.show(trigger);
  await Promise.resolve();
  assert.equal(document.body.style.overflow, "hidden");
  assert.equal(document.activeElement, first);
  assert.equal(typeof listeners.get("keydown"), "function");

  let prevented = false;
  listeners.get("keydown")({
    key: "Escape",
    preventDefault() { prevented = true; },
  });
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.equal(dialog.open.value, false);
  assert.equal(document.body.style.overflow, "auto");
  assert.equal(document.activeElement, trigger);
  cleanup();
});

test("tabs provide selection, panel visibility, and keyboard navigation", () => {
  const tabs = createTabs({
    id: "settings",
    tabs: [
      { value: "profile" },
      { value: "billing" },
      { value: "danger", disabled: true },
    ],
  });
  const targets = new Map();
  const document = {
    getElementById(id) { return targets.get(id) ?? null; },
  };
  let focused = "";
  for (const value of ["profile", "billing"]) {
    targets.set(`settings-tab-${value}`, { focus: () => { focused = value; } });
  }
  const profile = tabs.tab("profile");
  const billingPanel = tabs.panel("billing");

  assert.equal(profile["aria-selected"](), true);
  assert.equal(billingPanel.hidden(), true);
  let prevented = false;
  profile.onKeyDown({
    key: "ArrowRight",
    currentTarget: { ownerDocument: document },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(focused, "billing");
  assert.equal(tabs.selected.value, "billing");
  assert.equal(billingPanel.hidden(), false);
});

test("pagination clamps changing totals and emits compact page ranges", () => {
  const total = signal(200);
  const pagination = createPagination({
    total,
    pageSize: 10,
    initialPage: 10,
    siblingCount: 1,
  });
  assert.deepEqual(pagination.pages.value, [1, "ellipsis", 9, 10, 11, "ellipsis", 20]);
  assert.equal(pagination.start.value, 91);
  assert.equal(pagination.end.value, 100);

  total.value = 12;
  assert.equal(pagination.page.value, 2);
  assert.equal(pagination.pageCount.value, 2);
  assert.equal(pagination.start.value, 11);
  assert.equal(pagination.end.value, 12);
  pagination.previous();
  assert.equal(pagination.page.value, 1);
  pagination.dispose();
});
