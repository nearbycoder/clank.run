export declare const CLANK_THEME_PROTOCOL: "clank-theme/1";
export declare const CLANK_THEME_TOKEN_NAMES: readonly ["canvas", "canvasRaised", "surface", "surfaceMuted", "surfaceHover", "text", "textMuted", "textFaint", "border", "borderStrong", "accent", "accentHover", "accentContrast", "danger", "dangerContrast", "focus", "overlay", "radiusXs", "radiusSm", "radiusMd", "radiusLg", "radiusFull", "shadowSm", "shadowMd", "shadowLg", "fontSans", "fontMono", "controlHeight", "density", "borderWidth", "motionFast", "motionNormal"];
export type ClankThemeTokenName = typeof CLANK_THEME_TOKEN_NAMES[number];
export type ClankThemeTokens = Readonly<Record<ClankThemeTokenName, string>>;
export type ClankThemeScheme = "light" | "dark";
export interface ClankThemeInput {
    id: string;
    name: string;
    description: string;
    scheme: ClankThemeScheme;
    tokens: Record<ClankThemeTokenName, string>;
    tags?: readonly string[];
}
export interface ClankTheme {
    readonly protocol: typeof CLANK_THEME_PROTOCOL;
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly scheme: ClankThemeScheme;
    readonly tokens: ClankThemeTokens;
    readonly tags: readonly string[];
}
export interface ClankThemeStylesheetOptions {
    attribute?: string;
    rootFallback?: boolean;
}
export declare function defineClankTheme(input: ClankThemeInput): ClankTheme;
export declare const CLANK_THEME_PRESETS: readonly ClankTheme[];
export declare const CLANK_THEME_COUNT: 10;
export declare function getClankTheme(id: string): ClankTheme | undefined;
export declare function clankThemeVariables(theme: ClankTheme): Readonly<Record<`--clank-${string}`, string>>;
export declare function createClankThemeStylesheet(themes?: readonly ClankTheme[], options?: ClankThemeStylesheetOptions): string;
export declare function applyClankTheme(target: HTMLElement, theme: ClankTheme): () => void;
