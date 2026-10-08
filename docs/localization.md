# Localization

Define a catalog once, then use the same localized strings in human interfaces and agent descriptions. Catalog keys and interpolation arguments are inferred from literals. Translations must have the same keys, parameter names, and plural count field; malformed catalogs fail at initialization.

```ts
import { createI18n, defineMessages } from "@clank.run/framework/i18n";

const messages = defineMessages({
  greeting: "Hello {name}",
  items: { plural: "count", forms: { one: "{count} item", other: "{count} items" } },
});
const locale = createI18n({
  defaultLocale: "en",
  messages,
  translations: {
    fr: {
      greeting: "Bonjour {name}",
      items: { plural: "count", forms: { one: "{count} article", other: "{count} articles" } },
    },
  },
});

locale.t("greeting", { name: "Ada" });
locale.t("items", { count: 3 });
locale.setLocale("fr");
locale.number(1234.5);
locale.date(Date.now(), { dateStyle: "long" });
locale.relative(-1, "day", { numeric: "auto" });
```

Reading `locale.locale`, calling `t`, and formatting values participates in Clank reactivity. Use these expressions in ordinary TSX bindings or computed values. `manifest()` exposes the selected catalog and parameter names for localized agent metadata. It contains no supplied interpolation values. A language-region request such as `fr-CA` can use an available `fr` catalog; unknown languages fail without changing the selected locale.

Create one instance per server request or application root. Share the selected locale and explicit time zone through your existing SSR boot state so hydration formats the same values. The default time zone is UTC. Formatting uses the runtime's `Intl` locale data, and catalogs support the standard zero/one/two/few/many/other plural categories with required `other` fallback.

Messages are plain text. Render them through Clank text bindings; never treat translations or interpolated values as trusted HTML. Each catalog has at most 1,000 messages, each template has at most 8,192 characters, and at most 32 locale catalogs are accepted. Catalogs are copied and frozen. Parameters must be bounded strings or finite numbers; plural counts must be numbers.

This optional API does not change stored application records, authentication, or language negotiation. Existing applications can adopt it incrementally and remove it without a data migration. Locale-aware date/number display does not change how application schemas parse input: keep canonical numbers and timestamps in storage and explicitly validate form input.

## Extract and review translations

Use `@clank.run/framework/translation-review` to extract canonical catalog keys, placeholders
and source messages into a translator-editable JSON artifact. This uses declared catalogs;
it never executes scanned application files or guesses dynamic keys. Artifacts are limited
to 1 MiB and the catalog's existing 1,000-key bound.

```ts
import {
  exportTranslationBundle, reviewTranslationBundle, acceptTranslationReview,
} from "@clank.run/framework/translation-review";
const options = { sourceLocale: "en", targetLocale: "fr", current: currentFrench };
const bundle = await exportTranslationBundle(messages, options);
// Save/share bundle. Translators edit only each entry's translation value.
const review = await reviewTranslationBundle(messages, returnedJson, options);
// Present review.issues and review.changes for a human release decision.
// After approval, recheck against the current catalog before activating it:
const acceptedFrench = await acceptTranslationReview(messages, review, options);
```

Omit `current` for a new locale; exported translation values start as null. Missing keys,
unknown/duplicate keys, changed source text, altered parameter metadata, incompatible plural
counts, malformed translations and wrong locales reject import or produce non-accepting issues.
The diff includes before/after messages and keeps the existing typed key set. A failed review
has no catalog that can be activated. Source/current catalogs are SHA-256 fenced at both import
and acceptance, and acceptance rechecks the proposed content and displayed diff. Concurrent
catalog changes require a fresh export and review. A same-content retry returns the same catalog;
activation/publishing permissions belong to the application's human release workflow.

`await locale.revision()` hashes the selected locale and canonical accepted messages, excluding
interpolation values. `messageCatalogRevision(catalog, locale)` computes the same identity during
review. Server and browser formatting can assert the same accepted revision; reordering keys or
plural forms does not change it. The revision snapshots the selected locale before hashing, so
switching language during the asynchronous operation cannot mix catalogs. Web Crypto supplies
SHA-256 on both supported server runtimes and browsers in secure contexts.

The workflow adds no stored tables or automatic publication. Keep accepted catalogs in the
application's versioned assets and roll back by loading the previous catalog revision. Serve
the same accepted catalogs and selected locale to SSR and hydration; the workflow does not infer
an account's language or transfer private runtime values to translators.
