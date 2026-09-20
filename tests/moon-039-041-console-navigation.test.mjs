import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-console-navigation-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
await Promise.all([
  "platform-console", "ui-theme", "platform-console-project-sort", "platform-console-project-status",
  "platform-console-project-workspace", "platform-console-activity-search", "platform-console-activity-action",
  "platform-console-log-search", "platform-console-usage-export",
].map(async name => {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}));
const { platformConsolePage } = await import(pathToFileURL(join(directory, "platform-console.js")));
const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
const lines = html.split("\n");
const line = prefix => {
  const found = lines.find(value => value.startsWith(prefix));
  assert.ok(found, `missing console fixture: ${prefix}`);
  return found;
};
const source = [
  line("const sidebarMedia="),
  ...["navigate", "consoleFocusVisible", "sidebarIsOpen", "sidebarFocusTargets", "openSidebar", "closeSidebar", "handleSidebarKeydown", "handleConsoleFocus", "cancelNavigationFocus"].map(name => line(`function ${name}(`)),
  line("async function navigateWithFocus("), line('sidebarMedia.addEventListener('), line('q("#skip-navigation").onclick='),
  line('q("#sidebar-scrim").onclick='), line('q("#sidebar-close").onclick='),
  html.match(/q\("#mobile-menu"\)\.onclick=[^\n]+/)[0],
  ...lines.filter(value => value.startsWith('document.addEventListener(') && /handleSidebarKeydown|handleConsoleFocus|cancelNavigationFocus|a\[data-route\]/.test(value)),
  line('window.addEventListener("popstate"'),
].join("\n");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(mobile = true) {
  const nodes = new Map(), listeners = new Map(), windowListeners = new Map(), mediaListeners = [], history = [], hooks = {};
  const state = { routeGeneration: 0, navigationFocus: null, route: { kind: "overview" } };
  const initial = { authenticated: true };
  const document = { activeElement: null };
  const media = { matches: mobile, addEventListener(name, callback) { assert.equal(name, "change"); mediaListeners.push(callback); } };
  function dispatch(name, values = {}) {
    const event = { defaultPrevented: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, button: 0,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    for (const callback of listeners.get(name) || []) callback(event);
    return event;
  }
  function element(id, tagName = "DIV", focusable = false) {
    const classes = new Set();
    const node = { id, tagName, focusable, tabIndex: focusable ? 0 : -1, children: [], parentElement: null, attributes: {}, hidden: false, inert: false, disabled: false, rendered: true, visibility: "visible", isConnected: true, focuses: 0,
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
      closest(selector) { if (selector === "a[data-route]") return this.tagName === "A" ? this : null; assert.equal(selector, "[hidden],[inert]"); for (let current = this; current; current = current.parentElement) if (current.hidden || current.inert) return current; return null; },
      contains(other) { for (let current = other; current; current = current.parentElement) if (current === this) return true; return false; },
      getClientRects() { return this.rendered && !(id === "mobile-menu" || id === "sidebar-close") || this.rendered && media.matches ? [{}] : []; },
      matches(selector) { assert.equal(selector, ":disabled"); return this.disabled; },
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      focus(options) { if (this.disabled || this.closest("[hidden],[inert]")) return; this.focuses++; this.focusOptions = options; document.activeElement = this; dispatch("focusin", { target: this }); },
      scrollIntoView(options) { this.scrollOptions = options; },
    };
    nodes.set(`#${id}`, node);
    return node;
  }
  const body = element("body", "BODY"); document.body = body;
  const app = element("app-view"), sidebar = element("sidebar", "ASIDE"), main = element("main-content", "MAIN");
  const skip = element("skip-navigation", "A", true), toggle = element("mobile-menu", "BUTTON", true), close = element("sidebar-close", "BUTTON", true);
  const firstLink = element("nav-overview", "A", true), middle = element("nav-usage", "A", true), last = element("sign-out", "BUTTON", true);
  const hiddenGroup = element("hidden-navigation"), hiddenLink = element("hidden-link", "A", true), disabled = element("disabled-link", "BUTTON", true), invisible = element("invisible-link", "A", true), negative = element("negative-link", "A", true);
  hiddenGroup.hidden = true; hiddenGroup.append(hiddenLink); disabled.disabled = true; invisible.visibility = "hidden"; negative.tabIndex = -1;
  const scrim = element("sidebar-scrim", "BUTTON"); scrim.hidden = true;
  sidebar.append(close, firstLink, middle, hiddenGroup, disabled, invisible, negative, last);
  body.append(app); app.append(skip, sidebar, scrim, main); main.append(toggle);
  for (const kind of ["overview", "usage", "billing", "activity", "admin", "workspace", "project"]) {
    const section = element(`${kind}-page`, "SECTION"); section.hidden = kind !== "overview";
    const heading = element(kind === "project" ? "project-name" : `${kind}-heading`, "H1");
    section.append(heading); main.append(section);
  }
  const input = element("project-search", "INPUT", true); main.append(input);
  const outside = element("outside-control", "BUTTON", true); body.append(outside);
  let openDialog = null;
  const location = { pathname: "/overview", search: "", origin: "https://console.example.test" };
  const updateLocation = path => { const url = new URL(path, location.origin); location.pathname = url.pathname; location.search = url.search; };
  const context = { state, initial, document, hooks,
    q(selector) { return selector === "dialog[open]" ? openDialog : nodes.get(selector) || null; },
    qa(selector, root) { assert.equal(root, sidebar); const result = []; function walk(node) { for (const child of node.children) { if (child.focusable) result.push(child); walk(child); } } walk(root); return result; },
    window: { location, matchMedia(query) { assert.equal(query, "(max-width:900px)"); return media; },
      getComputedStyle(node) { let visibility = node.visibility; if (media.matches && sidebar.contains(node) && !sidebar.classList.contains("open")) visibility = "hidden"; return { visibility }; },
      history: { pushState(_data, _title, path) { history.push(["push", path]); updateLocation(path); }, replaceState(_data, _title, path) { history.push(["replace", path]); updateLocation(path); } },
      addEventListener(name, callback) { windowListeners.set(name, callback); },
    },
    applyRoute() { state.routeGeneration++; const part = location.pathname.split("/")[1]; const kind = part === "projects" ? "project" : part === "workspaces" ? "workspace" : part; state.route = { kind }; for (const name of ["overview", "usage", "billing", "activity", "admin", "workspace", "project"]) nodes.get(`#${name}-page`).hidden = name !== kind; context.closeSidebar(); return hooks.load?.(); },
  };
  document.addEventListener = (name, callback) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); };
  document.activeElement = toggle;
  runInNewContext(source, context);
  Object.assign(firstLink, { origin: location.origin, pathname: "/usage", search: "", target: "" });
  return { context, state, initial, document, media, history, hooks, sidebar, main, skip, toggle, close, firstLink, middle, last, input, outside, dispatch, q: context.q,
    setDialog(node) { openDialog = node; },
    resize(matches) { media.matches = matches; for (const callback of mediaListeners) callback({ matches }); },
    pop(path) { updateLocation(path); return windowListeners.get("popstate")(); },
  };
}

test("039: opening mobile navigation contains focus, marks a modal drawer, and makes background controls inert", () => {
  const f = fixture();
  f.toggle.onclick();
  assert.equal(f.document.activeElement, f.close);
  assert.equal(f.close.focusOptions.preventScroll, true);
  assert.equal(f.main.inert, true);
  assert.equal(f.skip.inert, true);
  assert.equal(f.sidebar.attributes.role, "dialog");
  assert.equal(f.sidebar.attributes["aria-modal"], "true");
  assert.equal(f.toggle.attributes["aria-expanded"], "true");
  assert.equal(f.q("#sidebar-scrim").hidden, false);
  assert.deepEqual(f.context.sidebarFocusTargets().map(node => node.id), ["sidebar-close", "nav-overview", "nav-usage", "sign-out"]);
});

test("039: Tab and Shift+Tab wrap only at drawer boundaries and outside focus is returned inside", () => {
  const f = fixture(); f.context.openSidebar();
  assert.equal(f.dispatch("keydown", { key: "Tab", shiftKey: true }).defaultPrevented, true);
  assert.equal(f.document.activeElement, f.last);
  assert.equal(f.dispatch("keydown", { key: "Tab" }).defaultPrevented, true);
  assert.equal(f.document.activeElement, f.close);
  f.middle.focus();
  assert.equal(f.dispatch("keydown", { key: "Tab" }).defaultPrevented, false);
  f.outside.focus();
  assert.equal(f.document.activeElement, f.close);
  for (const child of f.context.sidebarFocusTargets()) child.disabled = true;
  const empty = f.dispatch("keydown", { key: "Tab" });
  assert.equal(empty.defaultPrevented, true);
  assert.equal(f.document.activeElement, f.sidebar);
});

test("039: Escape, scrim, close button and toggle restore focus without leaving background inert", () => {
  for (const close of [f => f.dispatch("keydown", { key: "Escape" }), f => f.q("#sidebar-scrim").onclick(), f => f.close.onclick(), f => f.toggle.onclick()]) {
    const f = fixture(); f.context.openSidebar(); close(f);
    assert.equal(f.document.activeElement, f.toggle);
    assert.equal(f.sidebar.classList.contains("open"), false);
    assert.equal(f.main.inert, false);
    assert.equal(f.skip.inert, false);
    assert.equal(f.sidebar.attributes.role, undefined);
    assert.equal(f.sidebar.attributes["aria-modal"], undefined);
    assert.equal(f.toggle.attributes["aria-expanded"], "false");
    assert.equal(f.q("#sidebar-scrim").hidden, true);
  }
});

test("039: desktop, hidden authentication and native dialogs do not activate a drawer trap", () => {
  const desktop = fixture(false); desktop.toggle.onclick();
  assert.equal(desktop.main.inert, false);
  assert.equal(desktop.dispatch("keydown", { key: "Tab" }).defaultPrevented, false);
  const f = fixture(); f.context.openSidebar(); f.middle.focus(); f.resize(false);
  assert.equal(f.main.inert, false);
  assert.equal(f.sidebar.classList.contains("open"), false);
  assert.equal(f.document.activeElement, f.middle, "resizing never focuses the hidden menu toggle");
  assert.equal(f.dispatch("keydown", { key: "Tab" }).defaultPrevented, false);
  f.resize(true); f.q("#app-view").hidden = true; f.context.openSidebar();
  assert.equal(f.sidebar.classList.contains("open"), false);
  f.q("#app-view").hidden = false; f.initial.authenticated = false; f.context.openSidebar();
  assert.equal(f.sidebar.classList.contains("open"), false);
  f.initial.authenticated = true; f.setDialog({ open: true }); f.context.openSidebar();
  assert.equal(f.sidebar.classList.contains("open"), false);
});

test("040: skip navigation is visible on focus and targets main; all SPA route headings are programmatically focusable", () => {
  assert.match(html, /<a class="skip-link" id="skip-navigation" href="#main-content">Skip to main content/);
  assert.match(html, /<main class="main" id="main-content" tabindex="-1">/);
  assert.match(html, /\.skip-link:focus\{transform:none\}/);
  for (const id of ["overview-heading", "usage-heading", "billing-heading", "activity-heading", "admin-heading", "workspace-heading", "project-name"]) assert.match(html, new RegExp(`<h1 id="${id}" tabindex="-1">`));
  const f = fixture(); f.context.openSidebar();
  let prevented = false; f.skip.onclick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.document.activeElement, f.main);
  assert.equal(f.main.inert, false);
  assert.equal(f.main.scrollOptions.behavior, "auto");
  assert.deepEqual(f.history, []);
});

test("040: user route navigation waits for its heading and replaces drawer focus without flashing the toggle", async () => {
  const f = fixture(); f.context.openSidebar(); f.firstLink.focus();
  let resolve; f.hooks.load = () => new Promise(done => { resolve = done; });
  const pending = f.context.navigate("/projects/alpha/logs", false, true);
  assert.equal(f.sidebar.classList.contains("open"), false);
  assert.equal(f.main.inert, false);
  assert.equal(f.toggle.focuses, 0);
  assert.notEqual(f.document.activeElement, f.q("#project-name"));
  resolve(); await pending;
  assert.equal(f.document.activeElement, f.q("#project-name"));
  assert.equal(f.q("#project-name").focusOptions.preventScroll, true);
  assert.equal(f.state.navigationFocus, null);
});

test("040: delayed navigation never steals focus after another keyboard, pointer or focus interaction", async () => {
  for (const interact of [f => f.dispatch("keydown", { key: "Tab" }), f => f.dispatch("pointerdown", { target: f.input }), f => f.input.focus()]) {
    const f = fixture(); let resolve; f.hooks.load = () => new Promise(done => { resolve = done; });
    const pending = f.context.navigate("/usage", false, true);
    interact(f); const focused = f.document.activeElement; resolve(); await pending;
    assert.equal(f.document.activeElement, focused);
    assert.equal(f.q("#usage-heading").focuses, 0);
  }
});

test("040: superseded routes, hidden targets, dialogs and sign-out suppress pending heading focus", async () => {
  const f = fixture(); const completions = []; f.hooks.load = () => new Promise(resolve => completions.push(resolve));
  const first = f.context.navigate("/usage", false, true);
  const second = f.context.navigate("/activity", false, true);
  completions[0](); await first;
  assert.equal(f.q("#usage-heading").focuses, 0);
  completions[1](); await second;
  assert.equal(f.document.activeElement, f.q("#activity-heading"));
  for (const invalidate of [f => { f.initial.authenticated = false; }, f => f.setDialog({ open: true }), f => { f.q("#usage-heading").hidden = true; }, f => { f.state.routeGeneration++; }]) {
    const f = fixture(); let resolve; f.hooks.load = () => new Promise(done => { resolve = done; });
    const pending = f.context.navigate("/usage", false, true); invalidate(f); resolve(); await pending;
    assert.equal(f.q("#usage-heading").focuses, 0);
  }
});

test("040: initial and programmatic routes preserve focus; browser history and ordinary internal links announce headings", async () => {
  const f = fixture();
  await f.context.applyRoute();
  await f.context.navigate("/usage");
  assert.equal(f.document.activeElement, f.toggle);
  await f.pop("/activity");
  assert.equal(f.document.activeElement, f.q("#activity-heading"));
  const before = f.history.length;
  f.dispatch("click", { target: f.firstLink, ctrlKey: true });
  assert.equal(f.history.length, before);
  const click = f.dispatch("click", { target: f.firstLink }); await tick();
  assert.equal(click.defaultPrevented, true);
  assert.equal(f.document.activeElement, f.q("#usage-heading"));
  f.initial.authenticated = false;
  await f.pop("/overview");
  assert.equal(f.q("#overview-heading").focuses, 0);
});

test("041: reduced motion disables animation, transitions and smooth scrolling after every console/theme rule", () => {
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important;scroll-behavior:auto!important\}/);
  assert.match(css, /\.project-loading:after\{width:100%;transform:none;opacity:\.65\}\}\s*$/);
  assert.doesNotMatch(html, /behavior:\s*["']smooth["']/);
});

test("039/041: existing mobile zoom and touch scrolling policy remains intact", () => {
  assert.match(html, /content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/);
  assert.match(html, /html,body,body \*\{touch-action:pan-x pan-y\}/);
  assert.match(html, /body input,body select,body textarea\{font-size:16px!important\}/);
});
