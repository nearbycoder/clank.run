import { clankThemeVariables, type ClankTheme } from "../../vendor/ui.js";

export interface ComparedThemeToken {
  variable: string;
  leftValue: string;
  rightValue: string;
  changed: boolean;
}

/** Keep the framework's canonical CSS token order and compare exact values. */
export function compareThemeTokens(left: ClankTheme, right: ClankTheme, changedOnly = false) {
  const rightValues = clankThemeVariables(right);
  const tokens: ComparedThemeToken[] = Object.entries(clankThemeVariables(left)).map(([variable, leftValue]) => {
    const rightValue = rightValues[variable as keyof typeof rightValues];
    return { variable, leftValue, rightValue, changed: leftValue !== rightValue };
  });
  return {
    total: tokens.length,
    changedCount: tokens.filter((token) => token.changed).length,
    tokens: changedOnly ? tokens.filter((token) => token.changed) : tokens,
  };
}
