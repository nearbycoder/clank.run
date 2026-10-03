import { signal } from "./core.ts";

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type Message = string | { readonly plural: string; readonly forms: Readonly<Partial<Record<PluralCategory, string>> & { other: string }> };
export type MessageCatalog = Readonly<Record<string, Message>>;
type Names<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Names<Rest> : never;
type ParametersOf<M> = M extends string ? Names<M> : M extends { plural: infer P extends string; forms: infer F } ? P | Names<F[keyof F]> : never;
type ValuesOf<M> = Readonly<Record<ParametersOf<M>, string | number>> & (M extends { plural: infer P extends string } ? Readonly<Record<P, number>> : unknown);
export type MessageArguments<M> = [ParametersOf<M>] extends [never] ? [values?: Readonly<Record<string, never>>] : [values: ValuesOf<M>];
export type TranslatedCatalog<C extends MessageCatalog> = { readonly [K in keyof C]: Message };
export interface I18nOptions<C extends MessageCatalog> {
  defaultLocale: string;
  messages: C;
  translations?: Readonly<Record<string, TranslatedCatalog<C>>>;
  locale?: string;
  /** UTC by default, so server and browser dates agree. */
  timeZone?: string;
}
export interface I18n<C extends MessageCatalog> {
  readonly locale: string;
  readonly locales: readonly string[];
  setLocale(locale: string): void;
  t<K extends keyof C & string>(key: K, ...args: MessageArguments<C[K]>): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  relative(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string;
  manifest(): readonly { readonly key: string; readonly parameters: readonly string[]; readonly message: Message }[];
}

const PARAMETER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new TypeError("Messages must contain at most 8,192 characters.");
  for (const match of value.matchAll(/\{([^{}]*)\}/gu)) if (!PARAMETER.test(match[1]!)) throw new TypeError("Message placeholders must be named parameters.");
  return value;
}
function copyMessage(value: unknown): Message {
  if (typeof value === "string") return text(value);
  if (!plain(value) || Object.keys(value).some(key => !["plural", "forms"].includes(key))
    || typeof value.plural !== "string" || !PARAMETER.test(value.plural) || !plain(value.forms)
    || !Object.hasOwn(value.forms, "other")) throw new TypeError("Plural messages need a named count and an other form.");
  const forms: Record<string, string> = Object.create(null);
  for (const [key, formValue] of Object.entries(value.forms)) {
    if (!CATEGORIES.has(key)) throw new TypeError("Unknown plural category.");
    forms[key] = text(formValue);
  }
  return Object.freeze({ plural: value.plural, forms: Object.freeze(forms) as any });
}
function parameters(message: Message): string[] {
  const names = new Set<string>(typeof message === "string" ? [] : [message.plural]);
  for (const value of typeof message === "string" ? [message] : Object.values(message.forms)) {
    for (const match of value!.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)) names.add(match[1]!);
  }
  return [...names].sort();
}
/** Validate and freeze a catalog while retaining literal keys and parameter types. */
export function defineMessages<const C extends MessageCatalog>(catalog: C): C {
  if (!plain(catalog) || !Object.keys(catalog).length || Object.keys(catalog).length > 1000) throw new TypeError("Declare 1–1,000 messages.");
  const result: Record<string, Message> = Object.create(null);
  for (const [key, value] of Object.entries(catalog)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key) || ["constructor", "prototype", "__proto__"].includes(key)) throw new TypeError("Invalid message key.");
    result[key] = copyMessage(value);
  }
  return Object.freeze(result) as C;
}
function canonical(locale: string): string {
  if (typeof locale !== "string" || locale.length > 100) throw new TypeError("A bounded locale is required.");
  return Intl.getCanonicalLocales(locale)[0]!;
}

/** Request-local locale state shared by UI text, formatters and agent descriptions. */
export function createI18n<const C extends MessageCatalog>(options: I18nOptions<C>): I18n<C> {
  const fallback = canonical(options.defaultLocale);
  const base = defineMessages(options.messages);
  const catalogs = new Map<string, MessageCatalog>([[fallback, base]]);
  const translations = options.translations ?? {};
  if (!plain(translations) || Object.keys(translations).length > 31) throw new TypeError("At most 32 locales are supported per catalog.");
  for (const [rawLocale, source] of Object.entries(translations)) {
    const locale = canonical(rawLocale);
    if (catalogs.has(locale)) throw new TypeError("Locale catalogs must be unique.");
    const catalog = defineMessages(source);
    if (JSON.stringify(Object.keys(base).sort()) !== JSON.stringify(Object.keys(catalog).sort())) throw new TypeError("Translated catalogs must have exactly the default message keys.");
    for (const key of Object.keys(base)) {
      if (JSON.stringify(parameters(base[key]!)) !== JSON.stringify(parameters(catalog[key]!))
        || (typeof base[key] === "string") !== (typeof catalog[key] === "string")
        || (typeof base[key] !== "string" && (base[key] as Exclude<Message, string>).plural !== (catalog[key] as Exclude<Message, string>).plural)) {
        throw new TypeError(`Translation parameters differ for ${key}.`);
      }
    }
    catalogs.set(locale, catalog);
  }
  const resolve = (requested: string) => {
    let locale = canonical(requested);
    while (!catalogs.has(locale) && locale.includes("-")) locale = locale.slice(0, locale.lastIndexOf("-"));
    if (!catalogs.has(locale)) throw new RangeError("The requested locale has no catalog.");
    return locale;
  };
  const current = signal(resolve(options.locale ?? fallback));
  const timeZone = options.timeZone ?? "UTC";
  new Intl.DateTimeFormat(fallback, { timeZone });
  const finite = (value: number) => { if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("A finite number is required."); return value; };
  return Object.freeze({
    get locale() { return current.value; },
    locales: Object.freeze([...catalogs.keys()]),
    setLocale(locale: string) { current.value = resolve(locale); },
    t(key: string, values: Record<string, string | number> = {}) {
      const locale = current.value, catalog = catalogs.get(locale)!;
      if (!Object.hasOwn(catalog, key)) throw new TypeError("Unknown message key.");
      if (!plain(values)) throw new TypeError("Message parameters must be an object.");
      const message = catalog[key]!, names = parameters(message);
      if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(names)) throw new TypeError("Supply exactly the declared message parameters.");
      for (const value of Object.values(values)) {
        if (!(typeof value === "string" && value.length <= 65536) && !(typeof value === "number" && Number.isFinite(value))) throw new TypeError("Message parameters must be bounded text or finite numbers.");
      }
      let source: string;
      if (typeof message === "string") source = message;
      else {
        const count = finite(values[message.plural] as number);
        source = message.forms[new Intl.PluralRules(locale).select(count)] ?? message.forms.other;
      }
      return source.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_match, name) => String(values[name]));
    },
    number(value: number, format?: Intl.NumberFormatOptions) { return new Intl.NumberFormat(current.value, format).format(finite(value)); },
    date(value: Date | number, format?: Intl.DateTimeFormatOptions) { return new Intl.DateTimeFormat(current.value, { timeZone, ...format }).format(finite(value instanceof Date ? value.getTime() : value)); },
    relative(value: number, unit: Intl.RelativeTimeFormatUnit, format?: Intl.RelativeTimeFormatOptions) { return new Intl.RelativeTimeFormat(current.value, format).format(finite(value), unit); },
    manifest() { return Object.freeze(Object.entries(catalogs.get(current.value)!).map(([key, message]) => Object.freeze({ key, parameters: Object.freeze(parameters(message)), message }))); },
  }) as I18n<C>;
}
