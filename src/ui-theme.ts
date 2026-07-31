/** Dependency-free design tokens layered over Clank's unstyled headless components. */
export const CLANK_THEME_PROTOCOL = "clank-theme/1" as const;

export const CLANK_THEME_TOKEN_NAMES = [
  "canvas",
  "canvasRaised",
  "surface",
  "surfaceMuted",
  "surfaceHover",
  "text",
  "textMuted",
  "textFaint",
  "border",
  "borderStrong",
  "accent",
  "accentHover",
  "accentContrast",
  "danger",
  "dangerContrast",
  "focus",
  "overlay",
  "radiusXs",
  "radiusSm",
  "radiusMd",
  "radiusLg",
  "radiusFull",
  "shadowSm",
  "shadowMd",
  "shadowLg",
  "fontSans",
  "fontMono",
  "controlHeight",
  "density",
  "borderWidth",
  "motionFast",
  "motionNormal",
] as const;

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
  /** Attribute name used to select a preset. Defaults to data-clank-theme. */
  attribute?: string;
  /** Include the first theme as an unqualified :root fallback. Defaults to true. */
  rootFallback?: boolean;
}

const tokenToCssName = Object.freeze(Object.fromEntries(CLANK_THEME_TOKEN_NAMES.map((name) => [
  name,
  `--clank-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
]))) as Readonly<Record<ClankThemeTokenName, `--clank-${string}`>>;

const baseTokens: ClankThemeTokens = {
  canvas: "#0a0b0a",
  canvasRaised: "#0f100f",
  surface: "#141514",
  surfaceMuted: "#191a19",
  surfaceHover: "#202220",
  text: "#f4f7f2",
  textMuted: "#a2aaa0",
  textFaint: "#727970",
  border: "#2a2d29",
  borderStrong: "#444940",
  accent: "#9bef6b",
  accentHover: "#b3ff88",
  accentContrast: "#102008",
  danger: "#ff6b6b",
  dangerContrast: "#210606",
  focus: "#b3ff88",
  overlay: "rgba(0, 0, 0, .68)",
  radiusXs: "4px",
  radiusSm: "7px",
  radiusMd: "11px",
  radiusLg: "16px",
  radiusFull: "999px",
  shadowSm: "0 1px 2px rgba(0, 0, 0, .24)",
  shadowMd: "0 14px 35px rgba(0, 0, 0, .28)",
  shadowLg: "0 28px 90px rgba(0, 0, 0, .52)",
  fontSans: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontMono: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  controlHeight: "40px",
  density: "1",
  borderWidth: "1px",
  motionFast: "120ms",
  motionNormal: "220ms",
};

function tokens(overrides: Partial<ClankThemeTokens>): Record<ClankThemeTokenName, string> {
  return { ...baseTokens, ...overrides };
}

/** Validates and deeply freezes a custom theme before it can generate CSS. */
export function defineClankTheme(input: ClankThemeInput): ClankTheme {
  const id = bounded(input.id, "theme id", 2, 48);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id)) {
    throw new TypeError("Theme id must be lower-case kebab-case.");
  }
  const name = bounded(input.name, "theme name", 1, 80);
  const description = bounded(input.description, "theme description", 1, 240);
  if (input.scheme !== "light" && input.scheme !== "dark") {
    throw new TypeError("Theme scheme must be light or dark.");
  }
  const source = input.tokens as Record<string, unknown>;
  const expected = new Set<string>(CLANK_THEME_TOKEN_NAMES);
  for (const name of Object.keys(source)) {
    if (!expected.has(name)) throw new TypeError(`Unknown theme token: ${name}`);
  }
  const normalized = {} as Record<ClankThemeTokenName, string>;
  for (const name of CLANK_THEME_TOKEN_NAMES) {
    normalized[name] = cssValue(source[name], name);
  }
  const tags = [...new Set((input.tags ?? []).map((tag) => bounded(tag, "theme tag", 1, 32).toLowerCase()))];
  if (tags.length > 12) throw new RangeError("A theme may expose at most 12 tags.");
  return deepFreeze({
    protocol: CLANK_THEME_PROTOCOL,
    id,
    name,
    description,
    scheme: input.scheme,
    tokens: normalized,
    tags,
  });
}

const themePresets = [
  defineClankTheme({
    id: "clank",
    name: "Clank",
    description: "The original high-contrast workshop palette with an electric green signal.",
    scheme: "dark",
    tags: ["dark", "green", "balanced"],
    tokens: tokens({}),
  }),
  defineClankTheme({
    id: "porcelain",
    name: "Porcelain",
    description: "A precise daylight system with quiet blue controls and crisp geometry.",
    scheme: "light",
    tags: ["light", "blue", "product"],
    tokens: tokens({
      canvas: "#f6f8fb", canvasRaised: "#ffffff", surface: "#ffffff", surfaceMuted: "#eef2f7",
      surfaceHover: "#e4eaf2", text: "#152033", textMuted: "#5f6f86", textFaint: "#8895a7",
      border: "#d9e0e9", borderStrong: "#b6c0cd", accent: "#2764e7", accentHover: "#174fc7",
      accentContrast: "#ffffff", danger: "#d83b4b", dangerContrast: "#ffffff", focus: "#2764e7",
      overlay: "rgba(18, 31, 50, .46)", radiusXs: "3px", radiusSm: "6px", radiusMd: "9px",
      radiusLg: "13px", shadowSm: "0 1px 2px rgba(22, 34, 51, .08)",
      shadowMd: "0 14px 36px rgba(22, 34, 51, .13)", shadowLg: "0 30px 80px rgba(22, 34, 51, .2)",
    }),
  }),
  defineClankTheme({
    id: "midnight",
    name: "Midnight",
    description: "Deep navy surfaces, luminous cyan actions, and soft observability-style depth.",
    scheme: "dark",
    tags: ["dark", "cyan", "technical"],
    tokens: tokens({
      canvas: "#060b16", canvasRaised: "#091226", surface: "#0d1930", surfaceMuted: "#11213d",
      surfaceHover: "#172b4b", text: "#eaf4ff", textMuted: "#8fa7c4", textFaint: "#617895",
      border: "#203554", borderStrong: "#31547c", accent: "#54d7ff", accentHover: "#8be5ff",
      accentContrast: "#03131c", danger: "#ff718a", dangerContrast: "#26030a", focus: "#7ce1ff",
      overlay: "rgba(1, 5, 14, .76)", radiusXs: "5px", radiusSm: "9px", radiusMd: "14px",
      radiusLg: "20px", shadowMd: "0 18px 46px rgba(0, 4, 14, .52)", shadowLg: "0 36px 110px rgba(0, 4, 14, .72)",
    }),
  }),
  defineClankTheme({
    id: "sakura",
    name: "Sakura",
    description: "A soft editorial theme with blossom pink, plum text, and generous curves.",
    scheme: "light",
    tags: ["light", "pink", "soft"],
    tokens: tokens({
      canvas: "#fff7fa", canvasRaised: "#ffffff", surface: "#fffdfd", surfaceMuted: "#fbeaf1",
      surfaceHover: "#f7dfe9", text: "#3a1d2c", textMuted: "#7c5368", textFaint: "#a67e92",
      border: "#efd2df", borderStrong: "#dba9bf", accent: "#d94079", accentHover: "#b92660",
      accentContrast: "#ffffff", danger: "#c82f46", dangerContrast: "#ffffff", focus: "#e34e86",
      overlay: "rgba(58, 20, 40, .38)", radiusXs: "8px", radiusSm: "13px", radiusMd: "18px",
      radiusLg: "27px", shadowSm: "0 2px 6px rgba(97, 35, 65, .08)",
      shadowMd: "0 18px 42px rgba(97, 35, 65, .13)", shadowLg: "0 34px 90px rgba(97, 35, 65, .2)",
    }),
  }),
  defineClankTheme({
    id: "terminal",
    name: "Terminal",
    description: "Square edges, phosphor green, dense controls, and zero decorative softness.",
    scheme: "dark",
    tags: ["dark", "green", "square", "dense"],
    tokens: tokens({
      canvas: "#020503", canvasRaised: "#050906", surface: "#071008", surfaceMuted: "#0a160c",
      surfaceHover: "#102316", text: "#c8ffd3", textMuted: "#72bb82", textFaint: "#467851",
      border: "#1b4a27", borderStrong: "#2c7c3e", accent: "#45ff72", accentHover: "#85ff9f",
      accentContrast: "#001806", danger: "#ff5d5d", dangerContrast: "#210000", focus: "#45ff72",
      overlay: "rgba(0, 0, 0, .82)", radiusXs: "0", radiusSm: "0", radiusMd: "0", radiusLg: "0",
      shadowSm: "none", shadowMd: "0 0 0 1px #2c7c3e", shadowLg: "0 0 0 1px #45ff72",
      fontSans: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace", controlHeight: "34px",
      density: ".84", borderWidth: "1px", motionFast: "0ms", motionNormal: "0ms",
    }),
  }),
  defineClankTheme({
    id: "tangerine",
    name: "Tangerine",
    description: "Warm cream surfaces and saturated orange for energetic commerce interfaces.",
    scheme: "light",
    tags: ["light", "orange", "commerce"],
    tokens: tokens({
      canvas: "#fff9ef", canvasRaised: "#fffdf8", surface: "#ffffff", surfaceMuted: "#fff0d5",
      surfaceHover: "#ffe6bd", text: "#332112", textMuted: "#795d44", textFaint: "#a48769",
      border: "#ead8bd", borderStrong: "#cdb38e", accent: "#f06418", accentHover: "#d64a08",
      accentContrast: "#ffffff", danger: "#c9372c", dangerContrast: "#ffffff", focus: "#f06418",
      overlay: "rgba(57, 33, 13, .42)", radiusXs: "3px", radiusSm: "6px", radiusMd: "10px",
      radiusLg: "14px", shadowMd: "0 16px 38px rgba(90, 49, 15, .15)", shadowLg: "0 32px 90px rgba(90, 49, 15, .24)",
    }),
  }),
  defineClankTheme({
    id: "nordic",
    name: "Nordic",
    description: "Cool paper whites, fjord blue, restrained radii, and calm information density.",
    scheme: "light",
    tags: ["light", "teal", "minimal"],
    tokens: tokens({
      canvas: "#f3f7f6", canvasRaised: "#fbfdfc", surface: "#ffffff", surfaceMuted: "#e7efed",
      surfaceHover: "#dce9e6", text: "#17302f", textMuted: "#597371", textFaint: "#809794",
      border: "#cadbd8", borderStrong: "#9fbab6", accent: "#087f7a", accentHover: "#046862",
      accentContrast: "#ffffff", danger: "#bd3f42", dangerContrast: "#ffffff", focus: "#0a918b",
      overlay: "rgba(15, 42, 40, .4)", radiusXs: "2px", radiusSm: "4px", radiusMd: "7px",
      radiusLg: "10px", shadowMd: "0 14px 38px rgba(22, 57, 54, .12)", shadowLg: "0 30px 82px rgba(22, 57, 54, .2)",
      controlHeight: "38px", density: ".94",
    }),
  }),
  defineClankTheme({
    id: "grape",
    name: "Grape",
    description: "Dark aubergine panels, ultraviolet actions, and dramatic rounded silhouettes.",
    scheme: "dark",
    tags: ["dark", "purple", "rounded"],
    tokens: tokens({
      canvas: "#100817", canvasRaised: "#170c21", surface: "#20102e", surfaceMuted: "#2a1639",
      surfaceHover: "#362049", text: "#fbf2ff", textMuted: "#bea6cb", textFaint: "#897297",
      border: "#452a58", borderStrong: "#69417f", accent: "#c889ff", accentHover: "#d9adff",
      accentContrast: "#210631", danger: "#ff6f91", dangerContrast: "#29050f", focus: "#dfb9ff",
      overlay: "rgba(10, 2, 15, .74)", radiusXs: "10px", radiusSm: "15px", radiusMd: "22px",
      radiusLg: "32px", shadowSm: "0 3px 10px rgba(3, 0, 7, .3)",
      shadowMd: "0 20px 50px rgba(3, 0, 7, .5)", shadowLg: "0 40px 110px rgba(3, 0, 7, .68)",
    }),
  }),
  defineClankTheme({
    id: "sandstone",
    name: "Sandstone",
    description: "Architectural beige, rust accents, hairline geometry, and print-like restraint.",
    scheme: "light",
    tags: ["light", "earth", "square"],
    tokens: tokens({
      canvas: "#f3efe6", canvasRaised: "#faf7f0", surface: "#fffdf8", surfaceMuted: "#e9e1d3",
      surfaceHover: "#ded3c1", text: "#322d26", textMuted: "#70665a", textFaint: "#968b7c",
      border: "#d4c8b6", borderStrong: "#aa9b86", accent: "#a84822", accentHover: "#873715",
      accentContrast: "#fffaf3", danger: "#a33131", dangerContrast: "#ffffff", focus: "#b9562d",
      overlay: "rgba(48, 39, 29, .44)", radiusXs: "1px", radiusSm: "2px", radiusMd: "3px",
      radiusLg: "5px", shadowSm: "0 1px 0 rgba(55, 44, 31, .1)",
      shadowMd: "0 12px 30px rgba(55, 44, 31, .14)", shadowLg: "0 28px 74px rgba(55, 44, 31, .22)",
      borderWidth: "1px", controlHeight: "39px",
    }),
  }),
  defineClankTheme({
    id: "candy",
    name: "Candy",
    description: "Playful cloud surfaces, raspberry actions, pill controls, and buoyant shadows.",
    scheme: "light",
    tags: ["light", "pink", "playful", "pill"],
    tokens: tokens({
      canvas: "#f7f5ff", canvasRaised: "#ffffff", surface: "#ffffff", surfaceMuted: "#eeeaff",
      surfaceHover: "#e4ddff", text: "#2a2140", textMuted: "#6d6288", textFaint: "#958cab",
      border: "#ddd5f1", borderStrong: "#bdb0da", accent: "#ed3e8f", accentHover: "#d82575",
      accentContrast: "#ffffff", danger: "#d9364e", dangerContrast: "#ffffff", focus: "#7c59ff",
      overlay: "rgba(35, 24, 62, .4)", radiusXs: "12px", radiusSm: "18px", radiusMd: "24px",
      radiusLg: "32px", shadowSm: "0 4px 10px rgba(71, 51, 120, .1)",
      shadowMd: "0 18px 42px rgba(71, 51, 120, .16)", shadowLg: "0 36px 90px rgba(71, 51, 120, .24)",
      controlHeight: "44px", density: "1.06",
    }),
  }),
] as const;

/** Ten production-safe palettes spanning light/dark, density, radius, and depth choices. */
export const CLANK_THEME_PRESETS: readonly ClankTheme[] = deepFreeze(themePresets);
export const CLANK_THEME_COUNT = 10 as const;

/** Looks up a preset without silently accepting an unknown identifier. */
export function getClankTheme(id: string): ClankTheme | undefined {
  const normalized = id.trim().toLowerCase();
  return CLANK_THEME_PRESETS.find((theme) => theme.id === normalized);
}

/** Returns the exact stable CSS custom-property map for a validated theme. */
export function clankThemeVariables(theme: ClankTheme): Readonly<Record<`--clank-${string}`, string>> {
  assertTheme(theme);
  return Object.freeze(Object.fromEntries(CLANK_THEME_TOKEN_NAMES.map((name) => [
    tokenToCssName[name],
    theme.tokens[name],
  ]))) as Readonly<Record<`--clank-${string}`, string>>;
}

/** Generates a deterministic stylesheet for SSR, static builds, or ordinary CSS imports. */
export function createClankThemeStylesheet(
  themes: readonly ClankTheme[] = CLANK_THEME_PRESETS,
  options: ClankThemeStylesheetOptions = {},
): string {
  if (!Array.isArray(themes) || themes.length === 0 || themes.length > 64) {
    throw new RangeError("A theme stylesheet requires between 1 and 64 themes.");
  }
  const attribute = options.attribute ?? "data-clank-theme";
  if (!/^data-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(attribute)) {
    throw new TypeError("Theme attribute must be a data-* kebab-case name.");
  }
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const theme of themes) {
    assertTheme(theme);
    if (seen.has(theme.id)) throw new TypeError(`Duplicate theme id: ${theme.id}`);
    seen.add(theme.id);
    blocks.push(themeBlock(`:root[${attribute}="${theme.id}"]`, theme));
  }
  if (options.rootFallback !== false) blocks.unshift(themeBlock(":root", themes[0]));
  return `${blocks.join("\n")}\n`;
}

/** Applies a validated theme directly, including portal-safe document-root usage, and returns cleanup. */
export function applyClankTheme(target: HTMLElement, theme: ClankTheme): () => void {
  assertTheme(theme);
  if (!target || typeof target.setAttribute !== "function" || !target.style) {
    throw new TypeError("Theme target must be an HTMLElement.");
  }
  const previousId = target.getAttribute("data-clank-theme");
  const previousScheme = target.style.getPropertyValue("color-scheme");
  const previous = new Map<string, string>();
  for (const [name, value] of Object.entries(clankThemeVariables(theme))) {
    previous.set(name, target.style.getPropertyValue(name));
    target.style.setProperty(name, value);
  }
  target.setAttribute("data-clank-theme", theme.id);
  target.style.setProperty("color-scheme", theme.scheme);
  return () => {
    if (previousId === null) target.removeAttribute("data-clank-theme");
    else target.setAttribute("data-clank-theme", previousId);
    if (previousScheme) target.style.setProperty("color-scheme", previousScheme);
    else target.style.removeProperty("color-scheme");
    for (const [name, value] of previous) {
      if (value) target.style.setProperty(name, value);
      else target.style.removeProperty(name);
    }
  };
}

function themeBlock(selector: string, theme: ClankTheme): string {
  const declarations = Object.entries(clankThemeVariables(theme))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `${selector} {\n  color-scheme: ${theme.scheme};\n${declarations}\n}`;
}

function assertTheme(theme: ClankTheme): void {
  if (!theme || theme.protocol !== CLANK_THEME_PROTOCOL) throw new TypeError("Expected a validated Clank theme.");
  if (!Object.isFrozen(theme) || !Object.isFrozen(theme.tokens)) {
    throw new TypeError("Clank themes must be immutable.");
  }
}

function bounded(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new RangeError(`${label} must be between ${min} and ${max} characters.`);
  }
  if (/\p{Cc}/u.test(normalized)) throw new TypeError(`${label} cannot contain control characters.`);
  return normalized;
}

function cssValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`Theme token ${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[;{}\p{Cc}]/u.test(normalized)) {
    throw new TypeError(`Theme token ${name} is not a safe CSS value.`);
  }
  return normalized;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
