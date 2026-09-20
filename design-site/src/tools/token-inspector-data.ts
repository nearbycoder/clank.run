import type { ClankThemeTokens } from "../../vendor/ui.js";

export const TOKEN_GROUPS = ["Colors", "Typography", "Geometry", "Depth", "Motion"] as const;
export type TokenGroup = typeof TOKEN_GROUPS[number];
export interface InspectedToken {
  name: string;
  variable: string;
  value: string;
  group: TokenGroup;
}

function tokenGroup(name: string): TokenGroup {
  if (name.startsWith("font")) return "Typography";
  if (name.startsWith("shadow")) return "Depth";
  if (name.startsWith("motion")) return "Motion";
  if (name.startsWith("radius") || name === "controlHeight" || name === "density" || name === "borderWidth") return "Geometry";
  return "Colors";
}

/** Inspect the selected preset's exact values; search words match together. */
export function inspectThemeTokens(tokens: ClankThemeTokens, query = ""): InspectedToken[] {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return Object.entries(tokens).map(([name, value]) => ({
    name,
    variable: `--clank-${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
    value,
    group: tokenGroup(name),
  })).filter((token) => {
    const searchable = `${token.name} ${token.variable} ${token.value} ${token.group}`.toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}
