import { createI18n, defineMessages, messageCatalogRevision, type Message, type MessageCatalog, type TranslatedCatalog } from "./i18n.ts";

export interface TranslationReviewOptions {
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly current?: MessageCatalog;
}
export interface TranslationEntry {
  readonly key: string;
  readonly parameters: readonly string[];
  readonly source: Message;
  readonly translation: Message | null;
}
export interface TranslationBundle {
  readonly protocol: "clank-translation-review/1";
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly sourceRevision: string;
  readonly targetRevision: string | null;
  readonly entries: readonly TranslationEntry[];
}
export interface TranslationIssue { readonly key: string; readonly code: "MISSING_TRANSLATION" | "INVALID_TRANSLATION"; }
export interface TranslationChange { readonly key: string; readonly before: Message | null; readonly after: Message; }
export interface TranslationReview<C extends MessageCatalog = MessageCatalog> {
  readonly protocol: "clank-translation-diff/1";
  readonly ok: boolean;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly sourceRevision: string;
  readonly targetRevision: string | null;
  readonly proposedRevision: string | null;
  readonly issues: readonly TranslationIssue[];
  readonly changes: readonly TranslationChange[];
  readonly catalog: TranslatedCatalog<C> | null;
}

function locales(options: TranslationReviewOptions) {
  const source = Intl.getCanonicalLocales(options.sourceLocale)[0], target = Intl.getCanonicalLocales(options.targetLocale)[0];
  if (!source || !target || source === target || source.length > 100 || target.length > 100) throw new TypeError("Choose distinct bounded source and target locales.");
  return { source, target };
}
function bounded<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (!serialized || new TextEncoder().encode(serialized).length > 1024 * 1024) throw new RangeError("Translation review artifacts are limited to 1 MiB.");
  return JSON.parse(serialized) as T;
}
function sameMessage(left: Message, right: Message): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.plural === right.plural && JSON.stringify(Object.entries(left.forms).sort()) === JSON.stringify(Object.entries(right.forms).sort());
}
function validateCurrent<C extends MessageCatalog>(messages: C, options: TranslationReviewOptions) {
  const { source, target } = locales(options), catalog = defineMessages(messages);
  if (options.current) createI18n({ defaultLocale: source, messages: catalog, translations: { [target]: options.current as TranslatedCatalog<C> } });
  return { source, target, catalog, current: options.current ? defineMessages(options.current) : undefined };
}

/** Extract the canonical catalog into a translator-editable artifact without executing application source. */
export async function exportTranslationBundle<C extends MessageCatalog>(messages: C, options: TranslationReviewOptions): Promise<TranslationBundle> {
  const { source, target, catalog, current } = validateCurrent(messages, options);
  const manifest = createI18n({ defaultLocale: source, messages: catalog }).manifest();
  return bounded({ protocol: "clank-translation-review/1", sourceLocale: source, targetLocale: target,
    sourceRevision: await messageCatalogRevision(catalog, source), targetRevision: current ? await messageCatalogRevision(current, target) : null,
    entries: [...manifest].sort((a, b) => a.key.localeCompare(b.key)).map(entry => ({ key: entry.key, parameters: entry.parameters, source: entry.message, translation: current?.[entry.key] ?? null })) });
}

/** Validate imported keys/placeholders and return a version-fenced, reviewable diff. No catalog is activated. */
export async function reviewTranslationBundle<C extends MessageCatalog>(messages: C, input: unknown, options: TranslationReviewOptions): Promise<TranslationReview<C>> {
  const { source, target, catalog, current } = validateCurrent(messages, options), artifact = bounded(input) as TranslationBundle;
  const sourceRevision = await messageCatalogRevision(catalog, source), targetRevision = current ? await messageCatalogRevision(current, target) : null;
  if (!artifact || artifact.protocol !== "clank-translation-review/1" || artifact.sourceLocale !== source || artifact.targetLocale !== target || !Array.isArray(artifact.entries) || artifact.entries.length !== Object.keys(catalog).length) throw new TypeError("Translation artifact has an incompatible locale, protocol or key set.");
  if (artifact.sourceRevision !== sourceRevision || artifact.targetRevision !== targetRevision) throw new Error("Translation catalog changed; export and review a fresh artifact.");
  const manifest = new Map(createI18n({ defaultLocale: source, messages: catalog }).manifest().map(entry => [entry.key, entry]));
  const result: Record<string, Message> = Object.create(null), seen = new Set<string>(), issues: TranslationIssue[] = [], changes: TranslationChange[] = [];
  for (const entry of artifact.entries) {
    const original = entry && manifest.get(entry.key);
    if (!original || seen.has(entry.key) || !sameMessage(original.message, entry.source) || JSON.stringify(entry.parameters) !== JSON.stringify(original.parameters)) throw new TypeError("Translation source, parameters or keys were altered.");
    seen.add(entry.key);
    if (entry.translation === null) { issues.push({ key: entry.key, code: "MISSING_TRANSLATION" }); continue; }
    let translated: Message;
    try {
      translated = defineMessages({ [entry.key]: entry.translation })[entry.key]!;
      createI18n({ defaultLocale: source, messages: { [entry.key]: original.message }, translations: { [target]: { [entry.key]: translated } } });
    } catch { issues.push({ key: entry.key, code: "INVALID_TRANSLATION" }); continue; }
    result[entry.key] = translated;
    if (!current?.[entry.key] || !sameMessage(current[entry.key]!, translated)) changes.push({ key: entry.key, before: current?.[entry.key] ?? null, after: translated });
  }
  const accepted = issues.length ? null : defineMessages(result) as TranslatedCatalog<C>;
  return bounded({ protocol: "clank-translation-diff/1", ok: !issues.length, sourceLocale: source, targetLocale: target,
    sourceRevision, targetRevision, proposedRevision: accepted ? await messageCatalogRevision(accepted, target) : null,
    issues: issues.sort((a, b) => a.key.localeCompare(b.key)), changes: changes.sort((a, b) => a.key.localeCompare(b.key)), catalog: accepted });
}

/** Apply a reviewed diff only against the same source/current catalog, checking the proposed content identity again. */
export async function acceptTranslationReview<C extends MessageCatalog>(messages: C, review: TranslationReview<C>, options: TranslationReviewOptions): Promise<TranslatedCatalog<C>> {
  const { source, target, catalog, current } = validateCurrent(messages, options), snapshot = bounded(review);
  if (snapshot.protocol !== "clank-translation-diff/1" || !snapshot.ok || snapshot.issues.length || !snapshot.catalog || snapshot.sourceLocale !== source || snapshot.targetLocale !== target) throw new TypeError("Accept only a valid reviewed translation diff.");
  if (snapshot.sourceRevision !== await messageCatalogRevision(catalog, source) || snapshot.targetRevision !== (current ? await messageCatalogRevision(current, target) : null)) throw new Error("Translation catalog changed after review.");
  createI18n({ defaultLocale: source, messages: catalog, translations: { [target]: snapshot.catalog } });
  if (snapshot.proposedRevision !== await messageCatalogRevision(snapshot.catalog, target)) throw new Error("Reviewed translation content changed.");
  const expected = Object.keys(snapshot.catalog).filter(key => !current?.[key] || !sameMessage(current[key]!, snapshot.catalog![key]!)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(snapshot.changes.map(change => change.key).sort()) || snapshot.changes.some(change => !sameMessage(change.after, snapshot.catalog![change.key]!) || (change.before === null ? current?.[change.key] !== undefined : !current?.[change.key] || !sameMessage(change.before, current[change.key]!)))) throw new Error("Reviewed translation diff changed.");
  return defineMessages(snapshot.catalog);
}
