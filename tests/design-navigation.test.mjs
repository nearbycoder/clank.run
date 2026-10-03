import test from "node:test";
import assert from "node:assert/strict";
import { browser, elements, h, render, DesignStudio, settled } from "./helpers/design-studio-fixture.mjs";

function setup(t, mobile = true) {
  const f = browser(t);
  const media = f.view.matchMedia("(max-width: 760px)");
  media.matches = mobile;
  // Supply selector traversal for the established lightweight DOM fixture.
  const prototype = Object.getPrototypeOf(f.document.body);
  const originalClosest = prototype.closest;
  const originalQuery = prototype.querySelector;
  function matches(node, selector) {
    const parts = selector.trim().split(/\s+/u);
    const part = parts.pop();
    const tag = part.match(/^[a-z]+/iu)?.[0];
    const className = part.match(/\.([\w-]+)/u)?.[1];
    const attribute = part.match(/\[([\w-]+)(?:="([^"]*)")?\]/u);
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    if (className && !(node.getAttribute("class") ?? "").split(" ").includes(className)) return false;
    if (attribute && (!node.hasAttribute(attribute[1]) || attribute[2] !== undefined && node.getAttribute(attribute[1]) !== attribute[2])) return false;
    if (!parts.length) return true;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) if (matches(parent, parts.join(" "))) return true;
    return false;
  }
  prototype.querySelector = function (selector) { return elements(this).find((node) => selector.split(",").some((part) => matches(node, part))) ?? null; };
  prototype.closest = function (selector) {
    for (let node = this; node; node = node.parentElement) if (selector.split(",").some((part) => matches(node, part))) return node;
    return null;
  };
  t.after(() => { prototype.closest = originalClosest; if (originalQuery) prototype.querySelector = originalQuery; else delete prototype.querySelector; });
  f.document.querySelector = (selector) => f.document.body.querySelector(selector);
  const root = f.document.createElement("main"); f.document.body.append(root);
  const dispose = render(root, h(DesignStudio, { initialView: "input", initialTheme: "midnight", frameworkVersion: "test" }));
  f.onDispose(dispose);
  const trigger = elements(root).find((node) => node.getAttribute("aria-controls") === "studio-navigation");
  const search = elements(root).find((node) => node.getAttribute("aria-label") === "Search components");
  const main = f.document.getElementById("studio-main");
  const keyboard = (key, details = {}) => f.view.emit("keydown", { key, target: f.document.activeElement ?? main, ...details });
  return { ...f, root, trigger, search, main, media, dispose, keyboard };
}

test("mobile navigation restores focus and scroll on Escape, route changes, resizing, and disposal", async (t) => {
  const f = setup(t);
  f.document.body.style.overflow = "auto";
  f.trigger.emit("click"); await settled();
  assert.equal(f.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(f.document.activeElement.getAttribute("aria-current"), "page");
  assert.equal(f.document.body.style.overflow, "hidden");
  f.keyboard("Escape");
  assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.document.body.style.overflow, "auto");

  f.trigger.emit("click"); await settled();
  const themes = elements(f.root).find((node) => node.tagName === "A" && node.getAttribute("href")?.startsWith("/themes"));
  themes.emit("click", { button: 0 });
  assert.equal(f.view.location.pathname, "/themes");
  assert.equal(f.document.title, "Theme laboratory · Clank Design Studio");
  assert.equal(f.document.activeElement, f.main);
  assert.equal(f.document.body.style.overflow, "auto");

  f.trigger.emit("click"); await settled();
  f.media.matches = false; f.media.emit("change");
  assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(f.document.body.style.overflow, "auto");

  f.media.matches = true; f.trigger.emit("click"); await settled();
  f.dispose();
  assert.equal(f.document.body.style.overflow, "auto");
  assert.equal(f.media.listenerCount(), 0);
  assert.equal(f.view.listenerCount(), 0);
});

test("search shortcut, result focus, and Enter navigation preserve keyboard context", async (t) => {
  const f = setup(t);
  f.keyboard("/");
  assert.equal(f.document.activeElement, f.search);
  assert.equal(f.trigger.getAttribute("aria-expanded"), "true");
  f.search.value = "otp"; f.search.emit("input");
  f.search.emit("keydown", { key: "ArrowDown" });
  assert.equal(f.document.activeElement.getAttribute("href"), "/components/otp-field?theme=midnight");
  f.search.focus();
  for (const details of [{ isComposing: true }, { defaultPrevented: true }]) {
    f.search.emit("keydown", { key: "Enter", ...details });
    assert.equal(f.view.location.pathname, "/components/input");
    assert.equal(f.document.activeElement, f.search);
  }
  f.search.emit("keydown", { key: "Enter" });
  assert.equal(f.view.location.pathname, "/components/otp-field");
  assert.equal(f.document.title, "OTPField · Clank Design Studio");
  assert.equal(f.document.activeElement, f.main);
  assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(f.document.body.style.overflow, "");
});

test("search shortcuts respect editing, modifiers, modal focus, and navigation focus leaving the sidebar", async (t) => {
  const f = setup(t);
  const input = f.document.getElementById("story-input");
  input.focus(); f.keyboard("/");
  assert.equal(f.document.activeElement, input);
  f.main.focus();
  for (const details of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { getModifierState: (key) => key === "AltGraph" }, { isComposing: true }, { defaultPrevented: true }]) {
    f.keyboard("/", details); assert.equal(f.document.activeElement, f.main);
  }
  f.main.isContentEditable = true; f.keyboard("/"); assert.equal(f.document.activeElement, f.main); f.main.isContentEditable = false;
  const modal = f.document.createElement("section"); modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); f.document.body.append(modal);
  const close = f.document.createElement("button"); modal.append(close); close.focus();
  f.keyboard("/"); assert.equal(f.document.activeElement, close);
  f.document.body.removeChild(modal);
  f.keyboard("/", { target: f.main });
  f.view.emit("focusin", { target: f.main });
  assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(f.document.body.style.overflow, "");
});
