import test from "node:test";
import assert from "node:assert/strict";
import { createI18n, defineMessages } from "../dist/i18n.js";
import { effect } from "../dist/core.js";
import { h } from "../dist/dom.js";
import { renderToString } from "../dist/ssr.js";

const messages = {
  greeting: "Hello {name}",
  items: { plural: "count", forms: { one: "{count} item for {name}", other: "{count} items for {name}" } },
  save: "Save",
};
const french = {
  greeting: "Bonjour {name}",
  items: { plural: "count", forms: { one: "{count} article pour {name}", other: "{count} articles pour {name}" } },
  save: "Enregistrer",
};
const make = (options = {}) => createI18n({ defaultLocale: "en", messages, translations: { fr: french }, ...options });

test("locale changes update reactive UI labels and agent manifests from one frozen catalog", async () => {
  const input = structuredClone(messages), app = make({ messages: input }), observed = [];
  const dispose = effect(() => observed.push(app.t("greeting", { name: "Ada" })));
  input.greeting = "Changed";
  app.setLocale("fr-CA");
  assert.equal(app.locale, "fr");
  assert.deepEqual(observed, ["Hello Ada", "Bonjour Ada"]);
  assert.equal(app.t("items", { count: 0, name: "Ada" }), "0 article pour Ada");
  assert.equal(app.t("items", { count: 2, name: "Ada" }), "2 articles pour Ada");
  assert.equal(app.t("save"), "Enregistrer");
  assert.deepEqual(app.manifest().find(item => item.key === "greeting"), { key: "greeting", parameters: ["name"], message: "Bonjour {name}" });
  assert.ok(Object.isFrozen(app.manifest()));
  const html = await renderToString(h("p", {}, app.t("greeting", { name: '<img src=x onerror="alert(1)">' })), { markers: false });
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img"));
  dispose();
  app.setLocale("en");
  assert.equal(observed.length, 2);
});

test("translations reject missing keys, changed parameters and malformed plural contracts", () => {
  assert.throws(() => make({ translations: { fr: { greeting: "Bonjour" } } }), /keys/);
  assert.throws(() => make({ translations: { fr: { ...french, greeting: "Bonjour {person}" } } }), /parameters/);
  assert.throws(() => make({ translations: { fr: { ...french, items: "{count} {name}" } } }), /parameters/);
  assert.throws(() => defineMessages({ bad: { plural: "count", forms: { one: "one" } } }), /other/);
  assert.throws(() => defineMessages({ bad: { plural: "count", forms: { other: "many", unknown: "?" } } }), /category/);
  assert.throws(() => defineMessages({ bad: "{name:unsafe}" }), /placeholders/);
  assert.throws(() => defineMessages({ constructor: "bad" }), /key/);
  assert.throws(() => defineMessages({ large: "x".repeat(8193) }), /8,192/);
  assert.throws(() => defineMessages({}), /1,000/);
  assert.throws(() => make({ translations: { en: messages } }), /unique/);
});

test("message calls validate parameters and locale changes preserve state on failure", () => {
  const app = make();
  for (const input of [{}, { name: "Ada", extra: "x" }, { name: {} }, { name: Infinity }]) assert.throws(() => app.t("greeting", input));
  assert.throws(() => app.t("missing"));
  assert.throws(() => app.t("items", { count: "2", name: "Ada" }), /finite/);
  assert.throws(() => app.setLocale("de"), /catalog/);
  assert.throws(() => app.setLocale("invalid_!"));
  assert.equal(app.locale, "en");
  assert.throws(() => make({ timeZone: "Invalid/Zone" }));
});

test("locale formatters use explicit time zones and separate SSR request state", () => {
  const a = make(), b = make({ locale: "fr" });
  assert.equal(a.number(1234.5), new Intl.NumberFormat("en").format(1234.5));
  assert.equal(b.number(1234.5), new Intl.NumberFormat("fr").format(1234.5));
  const date = new Date("2026-01-01T00:00:00Z"), format = { year: "numeric", month: "long", day: "numeric" };
  assert.equal(a.date(date, format), new Intl.DateTimeFormat("en", { timeZone: "UTC", ...format }).format(date));
  assert.equal(b.relative(-1, "day", { numeric: "auto" }), "hier");
  a.setLocale("fr");
  b.setLocale("en");
  assert.equal(a.locale, "fr");
  assert.equal(b.locale, "en");
  assert.throws(() => a.number(NaN));
  assert.throws(() => a.date(new Date("invalid")));
  assert.throws(() => a.relative(Infinity, "day"));
});
