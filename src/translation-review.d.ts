import type { Message, MessageCatalog, TranslatedCatalog } from "./i18n.js";

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

export declare function exportTranslationBundle<C extends MessageCatalog>(messages: C, options: TranslationReviewOptions): Promise<TranslationBundle>;
export declare function reviewTranslationBundle<C extends MessageCatalog>(messages: C, input: unknown, options: TranslationReviewOptions): Promise<TranslationReview<C>>;
export declare function acceptTranslationReview<C extends MessageCatalog>(messages: C, review: TranslationReview<C>, options: TranslationReviewOptions): Promise<TranslatedCatalog<C>>;
