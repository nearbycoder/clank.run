import { CLANK_THEME_PRESETS } from "../vendor/ui-theme.js";

export const TRACKS = Object.freeze([
  { id: "kick", name: "Kick", kind: "drum", color: "coral", description: "Sub punch" },
  { id: "snare", name: "Snare", kind: "drum", color: "amber", description: "Noise crack" },
  { id: "hat", name: "Hi-hat", kind: "drum", color: "mint", description: "Bright tick" },
  { id: "clap", name: "Clap", kind: "drum", color: "lavender", description: "Wide snap" },
  { id: "bass", name: "Bass", kind: "bass", color: "blue", description: "Warm square" },
  { id: "lead", name: "Lead", kind: "lead", color: "pink", description: "Saw melody" },
]);
export const STEPS = Object.freeze(Array.from({ length: 16 }, (_, index) => index));
export const STORAGE_KEY = "clank-synth-pattern-v1";
export const MAX_PATTERN_BYTES = 16_384;
export const DEFAULT_MASTER = 0.78;
export const DEFAULT_LEVEL = 0.82;
export const PRESETS: Readonly<Record<string, { bpm: number; swing: number; pattern: readonly string[] }>> = Object.freeze({
  "Neon Pulse": { bpm: 112, swing: 8, pattern: ["x---x---x---x---", "----x-------x---", "x-x-x-x-x-x-x-x-", "--------x-------", "x--x--x---x--x--", "---x---x---x---x"] },
  "Night Drive": { bpm: 96, swing: 22, pattern: ["x-------x-------", "----x-------x---", "--x---x---x---x-", "--------x-------", "x--x----x--x----", "x---x-x---x---x-"] },
  "Arcade Bloom": { bpm: 128, swing: 4, pattern: ["x--x-x--x--x-x--", "----x-------x---", "xxxxxxxxxxxxxxxx", "--x-----x-----x-", "x-x-x---x-x-x---", "-x--x---x--x--x-"] },
  "Half Time": { bpm: 74, swing: 16, pattern: ["x-------x-------", "--------x-------", "x-x-x-x-x-x-x-x-", "--------x-------", "x-----x-x-----x-", "----x-------x---"] },
});
export type PatternDocument = { version: 1; name: string; bpm: number; swing: number; master: number; pattern: number[][]; volumes: number[] };
export const isPreset = (value: unknown): value is string => typeof value === "string" && (value === "Custom" || Object.hasOwn(PRESETS, value));
export function patternFromPreset(name: string): number[][] {
  return (Object.hasOwn(PRESETS, name) ? PRESETS[name] : PRESETS["Neon Pulse"]).pattern.map((row) => [...row].map((step) => step === "x" ? 1 : 0));
}
export function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function validPattern(value: unknown): value is number[][] {
  return Array.isArray(value) && value.length === TRACKS.length && value.every((row) => Array.isArray(row) && row.length === STEPS.length && row.every((step) => step === 0 || step === 1));
}
function validVolumes(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === TRACKS.length && value.every((level) => bounded(level, 0, 1));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseObject(raw: string): Record<string, unknown> {
  if (raw.length > MAX_PATTERN_BYTES || new TextEncoder().encode(raw).length > MAX_PATTERN_BYTES) throw new Error("Pattern files must be 16 KB or smaller.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Choose a valid JSON pattern file."); }
  if (!object(parsed)) throw new Error("Choose a Clank Synth pattern object.");
  return parsed;
}
export function readStoredState(raw: string | null): { preset?: string; theme?: string; bpm?: number; swing?: number; master?: number; pattern: number[][]; volumes?: number[] } | null {
  if (!raw) return null;
  try {
    const value = parseObject(raw);
    if (!validPattern(value.pattern)) return null;
    return {
      preset: isPreset(value.preset) ? value.preset : undefined,
      theme: CLANK_THEME_PRESETS.some((theme) => theme.id === value.theme) ? value.theme as string : undefined,
      bpm: bounded(value.bpm, 60, 180) ? value.bpm : undefined,
      swing: bounded(value.swing, 0, 40) ? value.swing : undefined,
      master: bounded(value.master, 0, 1) ? value.master : undefined,
      pattern: value.pattern.map((row) => [...row]),
      volumes: validVolumes(value.volumes) ? [...value.volumes] : undefined,
    };
  } catch { return null; }
}
export function importPattern(raw: string): PatternDocument {
  const value = parseObject(raw);
  if (value.version !== 1) throw new Error("This pattern version is unsupported. Choose a version 1 export.");
  if (!isPreset(value.name)) throw new Error("The pattern name must be Custom or a known preset.");
  if (!validPattern(value.pattern)) throw new Error("Patterns need six tracks of 16 steps, each 0 or 1.");
  if (!bounded(value.bpm, 60, 180) || !bounded(value.swing, 0, 40)) throw new Error("Tempo must be 60–180 BPM and swing must be 0–40%.");
  if (!bounded(value.master, 0, 1) || !validVolumes(value.volumes)) throw new Error("Master and all six track levels must be between 0 and 1.");
  return { version: 1, name: value.name, bpm: value.bpm, swing: value.swing, master: value.master, pattern: value.pattern.map((row) => [...row]), volumes: [...value.volumes] };
}
export function editTrack(pattern: number[][], track: number, action: "clear" | "left" | "right"): number[][] {
  return pattern.map((row, index) => index !== track ? row : action === "clear" ? row.map(() => 0) : action === "left" ? [...row.slice(1), row[0]] : [row[row.length - 1], ...row.slice(0, -1)]);
}
const clone = (value: PatternDocument): PatternDocument => ({ ...value, pattern: value.pattern.map((row) => [...row]), volumes: [...value.volumes] });
export function createPatternHistory(limit = 40) {
  const past: PatternDocument[] = [];
  const future: PatternDocument[] = [];
  const maximum = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 40;
  return {
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    record(before: PatternDocument, after: PatternDocument) {
      if (JSON.stringify(before) === JSON.stringify(after)) return false;
      past.push(clone(before));
      if (past.length > maximum) past.shift();
      future.length = 0;
      return true;
    },
    undo(current: PatternDocument) {
      const previous = past.pop();
      if (!previous) return null;
      future.push(clone(current));
      return clone(previous);
    },
    redo(current: PatternDocument) {
      const next = future.pop();
      if (!next) return null;
      past.push(clone(current));
      return clone(next);
    },
  };
}
export function createTapTempo() {
  let last: number | null = null;
  const intervals: number[] = [];
  return (time: number): number | null => {
    if (!Number.isFinite(time)) return null;
    const interval = last === null ? 0 : time - last;
    if (last === null || interval > 2000 || interval <= 0) {
      last = time;
      intervals.length = 0;
      return null;
    }
    if (interval < 150) return null;
    last = time;
    intervals.push(interval);
    if (intervals.length > 5) intervals.shift();
    return Math.round(Math.max(60, Math.min(180, 60_000 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length))));
  };
}
export function isTransportShortcut(event: KeyboardEvent): boolean {
  if (event.code !== "Space" || event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target as HTMLElement | null;
  return !target?.isContentEditable && !target?.closest?.('button, input, select, textarea, a[href], summary, [role="button"], [role="slider"], [role="textbox"], [contenteditable]:not([contenteditable="false"])');
}
export function stepDestination(key: string, track: number, step: number, wholeGrid = false): { track: number; step: number } | null {
  if (key === "ArrowLeft") return { track, step: Math.max(0, step - 1) };
  if (key === "ArrowRight") return { track, step: Math.min(STEPS.length - 1, step + 1) };
  if (key === "ArrowUp") return { track: Math.max(0, track - 1), step };
  if (key === "ArrowDown") return { track: Math.min(TRACKS.length - 1, track + 1), step };
  if (key === "Home") return { track: wholeGrid ? 0 : track, step: 0 };
  if (key === "End") return { track: wholeGrid ? TRACKS.length - 1 : track, step: STEPS.length - 1 };
  return null;
}
