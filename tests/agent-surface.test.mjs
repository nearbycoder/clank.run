import test from "node:test";
import assert from "node:assert/strict";

class SurfaceElement {
  constructor(tag, attributes = {}, text = "") {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes).map(([name, value]) => [name, String(value)]));
    this.children = [];
    this.parentElement = null;
    this.textContent = text;
    this.value = attributes.value === undefined ? "" : String(attributes.value);
    this.type = attributes.type === undefined ? "" : String(attributes.type);
    this.disabled = false;
    this.readOnly = false;
    this.required = Object.hasOwn(attributes, "required");
    this.checked = false;
    this.multiple = Object.hasOwn(attributes, "multiple");
    this.selectedOptions = [];
    this.options = [];
    this.isContentEditable = false;
    this.clicked = 0;
    this.events = [];
    this.labels = null;
  }
  get id() { return this.getAttribute("id") ?? ""; }
  get href() { return this.getAttribute("href") ?? ""; }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  closest(selector) {
    let current = this.parentElement;
    while (current) {
      if (selector === "label" && current.tagName === "LABEL") return current;
      current = current.parentElement;
    }
    return null;
  }
  click() { this.clicked++; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
  focus() {}
}

class SurfaceRoot {
  constructor(children) {
    this.children = children;
  }
  querySelectorAll(selector) {
    const all = [];
    const visit = (element) => {
      all.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    if (selector === "[id]") return all.filter((element) => element.hasAttribute("id"));
    if (selector === "label") return all.filter((element) => element.tagName === "LABEL");
    if (selector === "[data-clank-id], [id]") {
      return all.filter((element) => element.hasAttribute("data-clank-id") || element.hasAttribute("id"));
    }
    return [];
  }
}

const { createAgentSurface, inspectAgentSurface } = await import("../dist/ai.js");

test("agent inspection understands native form semantics without exposing secret values", () => {
  const emailLabel = new SurfaceElement("label", { for: "email" }, "Work email");
  const email = new SurfaceElement("input", {
    id: "email",
    name: "email",
    type: "email",
    required: "",
    value: "ada@example.com",
  });
  email.value = "ada@example.com";
  const password = new SurfaceElement("input", {
    id: "password",
    name: "password",
    type: "password",
    value: "never-inspect-this",
  });
  password.value = "never-inspect-this";
  const hidden = new SurfaceElement("input", { id: "csrf", type: "hidden", value: "secret-token" });
  const remember = new SurfaceElement("input", {
    id: "remember",
    name: "remember",
    type: "checkbox",
    "aria-label": "Remember this device",
    "aria-invalid": "true",
  });
  remember.checked = true;
  const root = new SurfaceRoot([emailLabel, email, password, hidden, remember]);

  const nodes = inspectAgentSurface(root);
  const emailNode = nodes.find((node) => node.id === "email");
  const passwordNode = nodes.find((node) => node.id === "password");
  const rememberNode = nodes.find((node) => node.id === "remember");
  assert.deepEqual(emailNode, {
    id: "email",
    tag: "input",
    role: "textbox",
    label: "Work email",
    name: "email",
    type: "email",
    required: true,
    value: "ada@example.com",
  });
  assert.equal(passwordNode.label, undefined);
  assert.equal(passwordNode.value, undefined);
  assert.equal(nodes.some((node) => node.id === "csrf"), false);
  assert.equal(rememberNode.checked, true);
  assert.equal(rememberNode.invalid, true);
});

test("agent operations support native IDs, protected controls, and multi-select values", () => {
  const button = new SurfaceElement("button", { id: "save" }, "Save");
  const email = new SurfaceElement("input", { id: "email", type: "email" });
  const password = new SurfaceElement("input", { id: "password", type: "password" });
  const file = new SurfaceElement("input", { id: "avatar", type: "file" });
  const select = new SurfaceElement("select", { id: "roles", multiple: "" });
  select.options = [
    { value: "editor", selected: false },
    { value: "reviewer", selected: false },
    { value: "admin", selected: false },
  ];
  select.selectedOptions = select.options.filter((option) => option.selected);
  const root = new SurfaceRoot([button, email, password, file, select]);
  const surface = createAgentSurface(root);

  assert.equal(surface.activate("save"), true);
  assert.equal(button.clicked, 1);
  assert.equal(surface.input("email", "agent@example.com"), true);
  assert.equal(email.value, "agent@example.com");
  assert.equal(surface.input("password", "write-only-secret"), true);
  assert.equal(password.value, "write-only-secret");
  assert.equal(surface.input("avatar", "fake-path"), false);
  assert.equal(surface.input("roles", ["editor", "reviewer"]), true);
  assert.deepEqual(select.options.map((option) => option.selected), [true, true, false]);
  assert.deepEqual(email.events, ["input", "change"]);
});
