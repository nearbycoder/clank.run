import test from "node:test";
import assert from "node:assert/strict";
import { createI18n, defineMessages, messageCatalogRevision } from "../dist/i18n.js";
import { exportTranslationBundle, reviewTranslationBundle, acceptTranslationReview } from "../dist/translation-review.js";

const messages = defineMessages({ greeting: "Hello {name}", count: { plural: "count", forms: { one: "{count} item", other: "{count} items" } } });
const french = defineMessages({ greeting: "Bonjour {name}", count: { plural: "count", forms: { other: "{count} articles", one: "{count} article" } } });
const options = { sourceLocale: "en", targetLocale: "fr" };
test("translator export/import produces a bounded reviewable diff and shared locale/content identity", async () => {
  const bundle = await exportTranslationBundle(messages, options);
  assert.deepEqual(bundle.entries.map(entry => [entry.key, entry.parameters]), [["count", ["count"]], ["greeting", ["name"]]]);
  assert.equal(bundle.targetRevision, null);
  for (const entry of bundle.entries) entry.translation = french[entry.key];
  const review = await reviewTranslationBundle(messages, JSON.parse(JSON.stringify(bundle)), options);
  assert.equal(review.ok, true); assert.equal(review.changes.length, 2); assert.deepEqual(review.issues, []);
  const accepted = await acceptTranslationReview(messages, review, options);
  const server = createI18n({ defaultLocale: "en", messages, translations: { fr: accepted }, locale: "fr" });
  const browser = createI18n({ defaultLocale: "en", messages, translations: { fr: JSON.parse(JSON.stringify(accepted)) }, locale: "fr" });
  assert.equal(server.t("greeting", { name: "Ada" }), "Bonjour Ada");
  assert.equal(browser.t("count", { count: 2 }), "2 articles");
  assert.equal(await server.revision(), review.proposedRevision); assert.equal(await browser.revision(), await server.revision());
  const reordered = { greeting: french.greeting, count: { plural: "count", forms: { one: french.count.forms.one, other: french.count.forms.other } } };
  assert.equal(await messageCatalogRevision(reordered, "fr"), review.proposedRevision);
  assert.notEqual(await messageCatalogRevision(french, "fr-CA"), review.proposedRevision);
  const nextBundle = await exportTranslationBundle(messages, { ...options, current: accepted });
  const unchanged = await reviewTranslationBundle(messages, nextBundle, { ...options, current: accepted });
  assert.deepEqual(unchanged.changes, []);
  assert.deepEqual(await acceptTranslationReview(messages, unchanged, { ...options, current: accepted }), accepted);
});

test("missing/incorrect placeholders reject activation and source/current changes invalidate both import and acceptance", async () => {
  const bundle = await exportTranslationBundle(messages, options);
  assert.deepEqual((await reviewTranslationBundle(messages, bundle, options)).issues.map(issue => issue.code), ["MISSING_TRANSLATION", "MISSING_TRANSLATION"]);
  bundle.entries.find(entry => entry.key === "greeting").translation = "Bonjour {secret}";
  bundle.entries.find(entry => entry.key === "count").translation = french.count;
  const invalid = await reviewTranslationBundle(messages, bundle, options);
  assert.equal(invalid.ok, false); assert.equal(invalid.catalog, null); assert.equal(invalid.proposedRevision, null);
  await assert.rejects(acceptTranslationReview(messages, invalid, options), /valid reviewed/u);
  bundle.entries.find(entry => entry.key === "greeting").translation = french.greeting;
  const review = await reviewTranslationBundle(messages, bundle, options);
  await assert.rejects(reviewTranslationBundle({ ...messages, greeting: "Welcome {name}" }, bundle, options), /changed/u);
  await assert.rejects(acceptTranslationReview(messages, review, { ...options, current: french }), /changed after review/u);
  review.catalog.greeting = "Salut {name}";
  await assert.rejects(acceptTranslationReview(messages, review, options), /content changed/u);
});

test("translation imports reject changed source, duplicate keys, altered diffs, wrong locales and oversized artifacts", async () => {
  const bundle = await exportTranslationBundle(messages, options);
  for (const entry of bundle.entries) entry.translation = french[entry.key];
  const changed = structuredClone(bundle); changed.entries[0].source.forms.other = "A changed source";
  await assert.rejects(reviewTranslationBundle(messages, changed, options), /altered/u);
  const duplicate = structuredClone(bundle); duplicate.entries[1] = duplicate.entries[0];
  await assert.rejects(reviewTranslationBundle(messages, duplicate, options), /altered/u);
  await assert.rejects(reviewTranslationBundle(messages, { ...bundle, targetLocale: "de" }, options), /incompatible locale/u);
  await assert.rejects(reviewTranslationBundle(messages, { ...bundle, extra: "x".repeat(1024 * 1024) }, options), /1 MiB/u);
  const review = await reviewTranslationBundle(messages, bundle, options); review.changes[0].after = "Altered diff";
  await assert.rejects(acceptTranslationReview(messages, review, options), /diff changed/u);
  await assert.rejects(exportTranslationBundle(messages, { ...options, targetLocale: "en" }), /distinct/u);
});
