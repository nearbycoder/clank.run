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
