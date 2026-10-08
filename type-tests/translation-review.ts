import { defineMessages, createI18n } from "@clank.run/framework/i18n";
import { exportTranslationBundle, reviewTranslationBundle, acceptTranslationReview } from "@clank.run/framework/translation-review";
const messages = defineMessages({ greeting: "Hello {name}" });
const options = { sourceLocale: "en", targetLocale: "fr" };
const bundle = await exportTranslationBundle(messages, options);
const review = await reviewTranslationBundle(messages, bundle, options);
const accepted = await acceptTranslationReview(messages, review, options);
accepted.greeting;
// @ts-expect-error The accepted catalog preserves the declared key set.
accepted.unknown;
const locale = createI18n({ defaultLocale: "en", messages, translations: { fr: accepted } });
locale.revision().then(revision => revision.toUpperCase());
// @ts-expect-error A translator target locale is required.
exportTranslationBundle(messages, { sourceLocale: "en" });
