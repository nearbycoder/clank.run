import type { ClankThemeTokens } from "../../vendor/ui.js";
import { inspectThemeTokens } from "./token-inspector-data.js";

type OpaqueColor = { status: "opaque"; channels: readonly [number, number, number] };
type UnavailableColor = { status: "translucent" | "unsupported"; reason: string };

/** Parse sRGB values without guessing a backing color for transparency. */
export function parseOpaqueColor(value: string | undefined): OpaqueColor | UnavailableColor {
  const unsupported: UnavailableColor = { status: "unsupported", reason: "Unsupported color format. Use an opaque sRGB hex or rgb() token." };
  const translucent: UnavailableColor = { status: "translucent", reason: "Translucent colors need a known composite background before contrast can be calculated." };
  if (typeof value !== "string") return unsupported;
  const color = value.trim().toLowerCase();
  if (color === "transparent") return translucent;
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/u.exec(color)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((part) => part + part).join("") : hex;
    if (expanded.length === 8 && expanded.slice(6) !== "ff") return translucent;
    return { status: "opaque", channels: [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16) / 255) as [number, number, number] };
  }
  const rgb = /^rgba?\(([^()]+)\)$/u.exec(color)?.[1];
  if (!rgb) return unsupported;
  const comma = rgb.includes(",");
  if (comma && rgb.includes("/")) return unsupported;
  const parts = comma ? rgb.split(",").map((part) => part.trim()) : rgb.split("/").map((part) => part.trim());
  const channels = comma ? parts.slice(0, 3) : parts[0].split(/\s+/u);
  const alpha = comma ? parts[3] : parts[1];
  if ((comma && parts.length !== 3 && parts.length !== 4) || (!comma && parts.length > 2) || channels.length !== 3) return unsupported;
  const number = /^\+?(?:\d+(?:\.\d*)?|\.\d+)%?$/u;
  if (!channels.every((part) => number.test(part)) || (alpha !== undefined && !number.test(alpha))) return unsupported;
  // Legacy comma notation cannot mix percentage and number channels.
  if (comma && channels.some((part) => part.endsWith("%")) && !channels.every((part) => part.endsWith("%"))) return unsupported;
  const normalized = channels.map((part) => parseFloat(part) / (part.endsWith("%") ? 100 : 255));
  const opacity = alpha === undefined ? 1 : parseFloat(alpha) / (alpha.endsWith("%") ? 100 : 1);
  if (normalized.some((part) => !Number.isFinite(part) || part < 0 || part > 1) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) return unsupported;
  if (opacity !== 1) return translucent;
  return { status: "opaque", channels: normalized as [number, number, number] };
}

function relativeLuminance(channels: readonly number[]): number {
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function calculateContrast(foreground: string | undefined, background: string | undefined): { ratio: number; reason: null } | { ratio: null; reason: string } {
  const front = parseOpaqueColor(foreground);
  const back = parseOpaqueColor(background);
  if (front.status !== "opaque") return { ratio: null, reason: `Foreground: ${front.reason}` };
  if (back.status !== "opaque") return { ratio: null, reason: `Background: ${back.reason}` };
  const first = relativeLuminance(front.channels);
  const second = relativeLuminance(back.channels);
  return { ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05), reason: null };
}

export function contrastChecks(ratio: number | null) {
  return [
    { label: "AA normal text", minimum: 4.5 },
    { label: "AA large text", minimum: 3 },
    { label: "AAA normal text", minimum: 7 },
    { label: "AAA large text", minimum: 4.5 },
  ].map((check) => ({ ...check, passes: ratio !== null && Number.isFinite(ratio) && ratio >= check.minimum }));
}

export function contrastTokenOptions(tokens: ClankThemeTokens) {
  return inspectThemeTokens(tokens).filter((token) => token.group === "Colors").map((token) => ({ ...token, color: parseOpaqueColor(token.value) }));
}
