import { CLANK_THEME_TOKEN_NAMES, defineClankTheme, getClankTheme, type ClankTheme, type ClankThemeTokenName } from "../../vendor/ui.js";
import { parseOpaqueColor } from "./contrast-checker-data.js";

export const SANDBOX_TOKEN_NAMES = Object.freeze(CLANK_THEME_TOKEN_NAMES.filter((name) => !name.startsWith("font") && !name.startsWith("shadow")));
export interface ThemeSandboxState {
  readonly baseId: string;
  readonly overrides: Readonly<Partial<Record<ClankThemeTokenName, string>>>;
}

export function sandboxTokenHint(name: string): string {
  if (name.startsWith("radius")) return "Radius: 0–1000px or 0–62.5rem.";
  if (name === "controlHeight") return "Control height: 24–80px or 1.5–5rem.";
  if (name === "borderWidth") return "Border width: 0–8px or 0–0.5rem.";
  if (name === "density") return "Density: a number from 0.5 to 1.5.";
  if (name.startsWith("motion")) return "Duration: 0–2000ms or 0–2s.";
  return "Color: hex, rgb(), rgba(), or transparent. No variables or other functions.";
}

/** A deliberately small grammar: no URL, escape, variable, expression, or arbitrary CSS input. */
export function validateSandboxToken(name: string, draft: unknown): { value: string; error: null } | { value: null; error: string } {
  const invalid = (error: string) => ({ value: null, error }) as const;
  if (!SANDBOX_TOKEN_NAMES.includes(name as ClankThemeTokenName)) return invalid("This token is not editable in the sandbox.");
  if (typeof draft !== "string" || draft.length > 96 || !draft.trim()) return invalid("Enter a value of 1–96 characters.");
  const value = draft.trim().toLowerCase();
  if (/[;{}<>\\@\u0000-\u001f\u007f]/u.test(draft) || /(?:url|image|expression|var|env|attr|calc|min|max|clamp)\s*\(/u.test(value)) return invalid("Use a literal token value; CSS functions, references, and network values are not allowed.");
  if (name === "density") {
    if (/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value) && Number(value) >= 0.5 && Number(value) <= 1.5) return { value, error: null };
  } else if (name.startsWith("radius") || name === "controlHeight" || name === "borderWidth" || name.startsWith("motion")) {
    if (value === "0" && (name.startsWith("radius") || name === "borderWidth")) return { value, error: null };
    const match = /^(\d+(?:\.\d+)?|\.\d+)(px|rem|ms|s)$/u.exec(value);
    if (match) {
      const number = Number(match[1]);
      const unit = match[2];
      if (name.startsWith("motion")) {
        if ((unit === "ms" || unit === "s") && number * (unit === "s" ? 1000 : 1) <= 2000) return { value, error: null };
      } else if (unit === "px" || unit === "rem") {
        const pixels = number * (unit === "rem" ? 16 : 1);
        const minimum = name === "controlHeight" ? 24 : 0;
        const maximum = name === "controlHeight" ? 80 : name === "borderWidth" ? 8 : 1000;
        if (pixels >= minimum && pixels <= maximum) return { value, error: null };
      }
    }
  } else if (parseOpaqueColor(value).status !== "unsupported") {
    return { value, error: null };
  }
  return invalid(sandboxTokenHint(name));
}

/** Changing the base starts a fresh sandbox; preset objects always remain untouched. */
export function createThemeSandbox(baseId: string): ThemeSandboxState {
  if (!getClankTheme(baseId)) throw new TypeError("Unknown sandbox preset.");
  return Object.freeze({ baseId, overrides: Object.freeze({}) });
}

export function applySandboxOverride(state: ThemeSandboxState, name: string, draft: unknown) {
  const checked = validateSandboxToken(name, draft);
  if (checked.error !== null) return { state, error: checked.error };
  const base = getClankTheme(state.baseId)!;
  const overrides = { ...state.overrides };
  const token = name as ClankThemeTokenName;
  if (checked.value === base.tokens[token]) delete overrides[token];
  else overrides[token] = checked.value;
  return { state: Object.freeze({ baseId: state.baseId, overrides: Object.freeze(overrides) }), error: null };
}

export function resetSandboxOverride(state: ThemeSandboxState, name?: ClankThemeTokenName): ThemeSandboxState {
  if (name === undefined) return createThemeSandbox(state.baseId);
  const overrides = { ...state.overrides };
  delete overrides[name];
  return Object.freeze({ baseId: state.baseId, overrides: Object.freeze(overrides) });
}

export function sandboxTheme(state: ThemeSandboxState): ClankTheme {
  const base = getClankTheme(state.baseId);
  if (!base) throw new TypeError("Unknown sandbox preset.");
  // Revalidate at the style boundary, including state supplied outside the editor.
  for (const [name, value] of Object.entries(state.overrides)) {
    const checked = validateSandboxToken(name, value);
    if (checked.error !== null) throw new TypeError(checked.error);
  }
  return defineClankTheme({ ...base, id: "sandbox-preview", name: `${base.name} sandbox`, tokens: { ...base.tokens, ...state.overrides } });
}
