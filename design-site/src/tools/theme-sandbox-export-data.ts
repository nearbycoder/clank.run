import { clankThemeVariables, getClankTheme } from "../../vendor/ui.js";
import { SANDBOX_TOKEN_NAMES, sandboxTheme, validateSandboxToken, type ThemeSandboxState } from "./theme-sandbox-data.js";
import type { ThemeExportFile } from "./theme-export-data.js";

/** Export only validated overrides under a fixed local selector, never caller-provided CSS. */
export function createSandboxExport(state: ThemeSandboxState): ThemeExportFile {
  if (!state || typeof state.baseId !== "string" || !state.overrides || typeof state.overrides !== "object" || Array.isArray(state.overrides)) throw new TypeError("Invalid sandbox state.");
  const base = getClankTheme(state.baseId);
  if (!base) throw new TypeError("Unknown sandbox preset.");
  const validated = sandboxTheme(state);
  const variables = clankThemeVariables(validated);
  const declarations = SANDBOX_TOKEN_NAMES.filter((name) => Object.hasOwn(state.overrides, name)).map((name) => {
    const checked = validateSandboxToken(name, state.overrides[name]);
    if (checked.error !== null) throw new TypeError(checked.error);
    const property = `--clank-${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
    if (!Object.hasOwn(variables, property)) throw new TypeError("Unknown CSS token.");
    return `  ${property}: ${checked.value};`;
  });
  return { filename: `clank-sandbox-${base.id}.css`, mediaType: "text/css;charset=utf-8",
    contents: `/* Apply after the ${base.id} preset. Add data-clank-sandbox to the target container. */\n[data-clank-sandbox] {\n${declarations.length ? declarations.join("\n") : "  /* No overrides applied. */"}\n}\n` };
}
