import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

export const GENERATED_BASELINE_PATH = ".clank/generated-baseline.json";
export function generatedBaseline(files) {
  const contents = JSON.stringify({ protocol: "clank-generated-baseline/1", files: Object.fromEntries(files.map((file) => [file.path, file.contents])) }, null, 2) + "\n";
  if (Buffer.byteLength(contents) > 16 * 1024 * 1024) throw new Error("Generated baseline exceeds 16 MiB.");
  return contents;
}

export async function readGeneratedBaseline(target) {
  const maximumBytes = 16 * 1024 * 1024;
  const unsafe = () => Object.assign(new Error("Generated baseline changed while being read."), { code: "COMPOSE_UNSAFE_TARGET" });
  let handle;
  try {
    const parentPath = join(target, ".clank");
    const parent = await lstat(parentPath, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw Object.assign(new Error("Generated baseline parent must be a regular directory."), { code: "COMPOSE_UNSAFE_TARGET" });
    const path = join(target, GENERATED_BASELINE_PATH);
    // Bind the read to one regular inode. Nonblocking open also refuses a raced
    // FIFO without waiting for a writer; the file-type check follows on the handle.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)) throw new Error("Generated baseline must be a bounded regular file.");
    const chunks = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximumBytes) throw new Error("Generated baseline must be a bounded regular file.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    const parentAfter = await lstat(parentPath, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(total) !== after.size || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()
      || parentAfter.dev !== parent.dev || parentAfter.ino !== parent.ino) throw unsafe();
    const baseline = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (baseline.protocol !== "clank-generated-baseline/1" || !baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files) || Object.values(baseline.files).some((contents) => typeof contents !== "string")) throw new Error("Invalid generated baseline.");
    return baseline.files;
  } catch (error) {
    if (error.code === "ENOENT" && !handle) return {};
    if (error.code === "ELOOP") throw Object.assign(new Error("Generated baseline must not be a symbolic link."), { code: "COMPOSE_UNSAFE_TARGET" });
    throw error;
  } finally {
    await handle?.close();
  }
}

// Patience anchors keep large generated files bounded while preserving multiple
// independent edits. Ambiguous/repeated regions become conservative conflicts.
function changes(base, next) {
  const result = [];
  let work = 0;
  function diff(a0, a1, b0, b1, depth = 0) {
    while (a0 < a1 && b0 < b1 && base[a0] === next[b0]) { a0++; b0++; }
    while (a0 < a1 && b0 < b1 && base[a1 - 1] === next[b1 - 1]) { a1--; b1--; }
    if (a0 === a1 && b0 === b1) return;
    work += a1 - a0 + b1 - b0;
    if (a0 === a1 || b0 === b1 || depth > 30 || work > 2_000_000) { result.push({ start: a0, end: a1, lines: next.slice(b0, b1) }); return; }
    const left = new Map(), right = new Map();
    for (let a = a0; a < a1; a++) left.set(base[a], left.has(base[a]) ? -1 : a);
    for (let b = b0; b < b1; b++) right.set(next[b], right.has(next[b]) ? -1 : b);
    const pairs = [...left].filter(([line, index]) => index >= 0 && (right.get(line) ?? -1) >= 0).map(([line, index]) => [index, right.get(line)]).sort((a, b) => a[0] - b[0]);
    const tails = [], previous = [];
    for (let i = 0; i < pairs.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1; else hi = mid; }
      previous[i] = lo ? tails[lo - 1] : -1;
      tails[lo] = i;
    }
    const anchors = [];
    for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) anchors.push(pairs[i]);
    anchors.reverse();
    if (!anchors.length) { result.push({ start: a0, end: a1, lines: next.slice(b0, b1) }); return; }
    for (const [a, b] of anchors) { diff(a0, a, b0, b, depth + 1); a0 = a + 1; b0 = b + 1; }
    diff(a0, a1, b0, b1, depth + 1);
  }
  diff(0, base.length, 0, next.length);
  return result;
}

/** No conflict markers are ever written into an application's executable source. */
export function mergeGeneratedFile(base, current, proposed) {
  if (current === undefined) return base === undefined ? { contents: proposed, conflict: false } : { contents: current, conflict: proposed !== base, deleted: true };
  if (current === proposed || current === base) return { contents: proposed, conflict: false };
  if (proposed === base) return { contents: current, conflict: false, preserved: true };
  if (base === undefined) return { contents: current, conflict: true };
  if ([base, current, proposed].some((text) => text.length > 8 * 1024 * 1024)) return { contents: current, conflict: true };
  const lines = base.split(/(?<=\n)/u);
  const local = changes(lines, current.split(/(?<=\n)/u));
  const remote = changes(lines, proposed.split(/(?<=\n)/u));
  const merged = [...local];
  for (const update of remote) {
    let duplicate = false;
    for (const edit of local) {
      if (update.start === edit.start && update.end === edit.end && update.lines.join("") === edit.lines.join("")) { duplicate = true; break; }
      const overlaps = update.start === update.end || edit.start === edit.end
        ? update.start <= edit.end && edit.start <= update.end
        : update.start < edit.end && edit.start < update.end;
      if (overlaps) return { contents: current, conflict: true, range: { start: Math.min(update.start, edit.start) + 1, end: Math.max(update.end, edit.end) + 1 } };
    }
    if (!duplicate) merged.push(update);
  }
  for (const edit of merged.sort((a, b) => b.start - a.start)) lines.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return { contents: lines.join(""), conflict: false, preserved: true };
}

export function mergeGeneratedDestination(path, base, current, proposed) {
  // Applied SQL files are immutable; changes require a new migration ID.
  if (path.startsWith("migrations/") && base !== undefined && current !== undefined) return { contents: current, conflict: current !== base, preserved: current !== proposed };
  return mergeGeneratedFile(base, current, proposed);
}
