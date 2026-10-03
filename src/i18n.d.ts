
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

export declare function defineMessages<const C extends MessageCatalog>(catalog: C): C;
export declare function createI18n<const C extends MessageCatalog>(options: I18nOptions<C>): I18n<C>;
