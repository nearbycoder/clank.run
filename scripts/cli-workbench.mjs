import { lstat, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { defineGovernancePolicy, evaluateFeatureFlag, evaluatePolicy } from "../dist/governance.js";
import { assessRollout, createPortableProjectExport, createPromotionPlan, createReleaseProvenance, createRevisionLedger, createSanitizedClone, estimateCapacity, nextPromotion } from "../dist/lifecycle.js";
import { checkProductionParity, compareVisuals, diffSchemas, planFrameworkUpgrade, testActionContract } from "../dist/tooling.js";
import { runDeploymentProviderConformance } from "../dist/provider.js";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const EXCLUDED = new Set([".git", ".clank", ".proact", "node_modules", ".env", ".envrc", ".dev.vars", ".npmrc", ".yarnrc", ".pypirc", ".netrc", ".ssh", ".aws", "id_rsa", "id_ed25519"]);

export async function runWorkbench(args) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === "help" || args.includes("--help") || args.includes("-h")) return help();
  const json = args.includes("--json");
  const values = args.filter((item) => !item.startsWith("--"));
  const option = (name) => args.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  let result;
  switch (subcommand) {
    case "policy": {
      const [file, action] = values;
      required(file && action, "Usage: clank workbench policy <policy.json> <action> --principal=<id> --kind=<user|agent|service> [--roles=a,b] [--resource=<resource>]");
      const policy = defineGovernancePolicy(await jsonFile(file));
      result = evaluatePolicy(policy, { action, principal: { id: requiredOption(option("principal"), "--principal"), kind: requiredOption(option("kind"), "--kind"), roles: csv(option("roles")) }, ...(option("resource") ? { resource: option("resource") } : {}) });
      break;
    }
    case "flag": {
      const [file, key] = values;
      required(file && key, "Usage: clank workbench flag <policy.json> <key> [--subject=<id>] [--principal=<id> --kind=<kind> --roles=a,b]");
      const principal = option("principal") ? { id: option("principal"), kind: option("kind") ?? "user", roles: csv(option("roles")) } : undefined;
      result = evaluateFeatureFlag(defineGovernancePolicy(await jsonFile(file)), key, { ...(option("subject") ? { subject: option("subject") } : {}), ...(principal ? { principal } : {}) });
      break;
    }
    case "revision": {
      const [file] = values;
      required(file, "Usage: clank workbench revision <ledger.json> [--revision=<number>]");
      const source = await jsonFile(file);
      const ledger = createRevisionLedger(source.initialState, source.events);
      const { inspectRevision } = await import("../dist/lifecycle.js");
      result = inspectRevision(ledger, option("revision") === undefined ? undefined : number(option("revision"), "--revision"));
      break;
    }
    case "parity": {
      const [local, production] = values;
      required(local && production, "Usage: clank workbench parity <local.json> <production.json>");
      result = checkProductionParity(await jsonFile(local), await jsonFile(production));
      break;
    }
    case "schema": {
      const [current, target] = values;
      required(current && target, "Usage: clank workbench schema <current.json> <target.json> [--output=<migration.sql>]");
      result = diffSchemas(await jsonFile(current), await jsonFile(target));
      if (option("output")) await privateWrite(resolve(option("output")), result.migrationSql);
      break;
    }
    case "capacity": {
      const [workload, rates] = values;
      required(workload && rates, "Usage: clank workbench capacity <workload.json> <rate-card.json>");
      result = estimateCapacity(await jsonFile(workload), await jsonFile(rates));
      break;
    }
    case "upgrade": {
      const [manifest] = values;
      required(manifest, "Usage: clank workbench upgrade <manifest.json> [--node=<major>] [--exports=a,b]");
      result = planFrameworkUpgrade(await jsonFile(manifest), { nodeMajor: number(option("node") ?? process.versions.node.split(".")[0], "--node"), usedExports: csv(option("exports")) });
      break;
    }
    case "provenance": {
      const [file] = values;
      required(file, "Usage: clank workbench provenance <release-material.json>");
      result = await createReleaseProvenance(await jsonFile(file));
      break;
    }
    case "promotion": {
      const [release, stages, evidence] = values;
      required(release && stages, "Usage: clank workbench promotion <provenance.json> <stages.json> [evidence.json]");
      const plan = createPromotionPlan(await jsonFile(release), await jsonFile(stages));
      result = evidence ? { plan, decision: nextPromotion(plan, await jsonFile(evidence)) } : plan;
      break;
    }
    case "rollout": {
      const [metrics, guardrails] = values;
      required(metrics && guardrails, "Usage: clank workbench rollout <metrics.json> <guardrails.json>");
      result = assessRollout(await jsonFile(metrics), await jsonFile(guardrails));
      break;
    }
    case "export": {
      const [directory = "."] = values;
      const root = resolve(directory);
      const output = resolve(option("output") ?? `${basename(root)}.clank-export.json`);
      const files = await exportFiles(root, output);
      result = await createPortableProjectExport({ name: option("name") ?? basename(root), frameworkVersion: option("framework") ?? "unknown", files });
      await privateWrite(output, `${JSON.stringify(result)}\n`, option("force") === "true");
      result = { protocol: "clank-project-export-result/1", output, digest: result.digest, files: result.files.length, bytes: result.files.reduce((sum, file) => sum + file.size, 0) };
      break;
    }
    case "sanitize": {
      const [rows, policy] = values;
      required(rows && policy, "Usage: CLANK_CLONE_SALT=<secret> clank workbench sanitize <rows.json> <policy.json> [--output=<file>]");
      required(process.env.CLANK_CLONE_SALT, "CLANK_CLONE_SALT is required and must not be passed on the command line.");
      result = await createSanitizedClone(await jsonFile(rows), await jsonFile(policy), process.env.CLANK_CLONE_SALT);
      if (option("output")) await privateWrite(resolve(option("output")), `${JSON.stringify(result, null, 2)}\n`);
      break;
    }
    case "provider": {
      const [modulePath] = values;
      required(modulePath, "Usage: clank workbench provider <provider.mjs> [--export=<name>] [--project=<id> --destructive=true]");
      const module = await importLocal(modulePath);
      const provider = module[option("export") ?? "default"];
      result = await runDeploymentProviderConformance(provider, { ...(option("project") ? { projectId: option("project") } : {}), destructive: option("destructive") === "true" });
      break;
    }
    case "contract": {
      const [modulePath, exportName] = values;
      required(modulePath && exportName, "Usage: clank workbench contract <actions.mjs> <export-name>");
      const module = await importLocal(modulePath);
      result = await testActionContract(module[exportName]);
      break;
    }
    case "visual": {
      const [baseline, current] = values;
      required(baseline && current, "Usage: clank workbench visual <baseline.png|json> <current.png|json> [--tolerance=<0-255>] [--ratio=<0-1>]");
      const left = await visualFile(baseline);
      const right = await visualFile(current);
      result = compareVisuals(left, right, { ...(option("tolerance") ? { channelTolerance: number(option("tolerance"), "--tolerance") } : {}), ...(option("ratio") ? { maximumChangedRatio: finiteNumber(option("ratio"), "--ratio") } : {}) });
      break;
    }
    default: throw new Error(`Unknown workbench command: ${subcommand}. Run clank workbench help.`);
  }
  if (json) console.log(JSON.stringify(result));
  else console.log(JSON.stringify(result, null, 2));
  if (result?.ok === false
    || result?.matches === false
    || result?.ready === false
    || result?.decision?.ready === false
    || (result?.action && result.action !== "continue")) process.exitCode = 1;
}

function help() {
  console.log(`Clank workbench

Usage:
  clank workbench policy <policy.json> <action>   Evaluate user/agent authorization
  clank workbench flag <policy.json> <key>        Evaluate a typed feature flag
  clank workbench revision <ledger.json>          Replay and inspect an app revision
  clank workbench parity <local.json> <prod.json> Compare local/production contracts
  clank workbench schema <from.json> <to.json>    Build a classified migration plan
  clank workbench capacity <load.json> <rates.json> Estimate capacity and cost
  clank workbench upgrade <manifest.json>         Plan a framework upgrade
  clank workbench provenance <material.json>      Create release provenance
  clank workbench promotion <release> <stages>    Evaluate promotion evidence
  clank workbench rollout <metrics> <guardrails>  Continue, pause, or roll back
  clank workbench export [directory]              Create a portable project export
  clank workbench sanitize <rows> <policy>         Build a deterministic safe clone
  clank workbench provider <provider.mjs>          Run provider conformance
  clank workbench contract <module> <export>       Generate action contract tests
  clank workbench visual <baseline> <current>      Compare PNG or decoded RGBA baselines

All commands support --json. Inputs are bounded data files; no package hooks run.`);
}

async function jsonFile(path) { const target = resolve(path); const stats = await lstat(target); if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_JSON_BYTES) throw new Error(`JSON input is not a bounded regular file: ${path}`); try { return JSON.parse(await readFile(target, "utf8")); } catch { throw new Error(`JSON input is invalid: ${path}`); } }
async function privateWrite(target, contents, force = false) { if (!force) return writeFile(target, contents, { flag: "wx", mode: 0o600 }); const temporary = join(dirname(target), `.${basename(target)}.clank-${process.pid}-${crypto.randomUUID()}`); try { await writeFile(temporary, contents, { flag: "wx", mode: 0o600 }); await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; } }
async function visualFile(path) {
  const target = resolve(path);
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_JSON_BYTES) throw new Error(`Visual input is not a bounded regular file: ${path}`);
  const bytes = new Uint8Array(await readFile(target));
  return pngSignature(bytes) ? decodePng(bytes) : visualImage(parseJson(bytes, path));
}
async function importLocal(path) { const target = resolve(path); const stats = await lstat(target); if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_JSON_BYTES) throw new Error("Module must be a bounded regular file."); return import(`${pathToFileURL(target).href}?workbench=${stats.mtimeMs}`); }
async function exportFiles(root, excludedPath) { const rootStats = await lstat(root); if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("Export root must be a real directory."); const output = []; async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { if (excludedExportEntry(entry.name)) continue; const path = join(directory, entry.name); if (resolve(path) === excludedPath) continue; if (entry.isSymbolicLink()) throw new Error(`Project exports reject symbolic links: ${relative(root, path)}`); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) { const stats = await lstat(path); if (stats.size > 8 * 1024 * 1024) throw new Error(`Export file exceeds 8 MiB: ${relative(root, path)}`); output.push({ path: relative(root, path).replaceAll("\\", "/"), bytes: new Uint8Array(await readFile(path)), mode: stats.mode & 0o111 ? 0o755 : 0o644 }); } } } await visit(root); return output; }
function excludedExportEntry(name) { return EXCLUDED.has(name) || name.startsWith(".env.") || name.endsWith(".sqlite") || name.endsWith(".sqlite-wal") || name.endsWith(".sqlite-shm") || name.endsWith(".clank-export.json"); }
function visualImage(value) { if (!value || !Array.isArray(value.rgba)) throw new Error("Visual JSON must contain width, height, and an RGBA byte array."); return { width: value.width, height: value.height, rgba: Uint8Array.from(value.rgba) }; }
function parseJson(bytes, path) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`Visual JSON input is invalid: ${path}`); } }
function pngSignature(bytes) { return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value); }
function decodePng(bytes) {
  let offset = 8;
  let header;
  const compressed = [];
  let compressedBytes = 0;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("PNG contains a truncated chunk.");
    const length = uint32(bytes, offset);
    const end = offset + 12 + length;
    if (length > MAX_JSON_BYTES || end > bytes.length) throw new Error("PNG chunk exceeds its input bounds.");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(typeBytes, data) !== uint32(bytes, offset + 8 + length)) throw new Error(`PNG ${type} checksum is invalid.`);
    if (type === "IHDR") {
      if (header || length !== 13 || offset !== 8) throw new Error("PNG header is invalid.");
      const width = uint32(data, 0);
      const height = uint32(data, 4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (!width || !height || width > 20_000 || height > 20_000 || width * height > 16_777_216) throw new Error("PNG dimensions exceed the visual workbench limit.");
      if (bitDepth !== 8 || ![2, 6].includes(colorType) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error("PNG must be a non-interlaced 8-bit RGB or RGBA image.");
      header = { width, height, channels: colorType === 6 ? 4 : 3 };
    } else if (type === "IDAT") {
      if (!header || ended) throw new Error("PNG image data is out of order.");
      compressedBytes += data.length;
      if (compressedBytes > MAX_JSON_BYTES) throw new Error("PNG compressed data exceeds the visual workbench limit.");
      compressed.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !header || compressed.length === 0) throw new Error("PNG end marker is invalid.");
      ended = true;
      offset = end;
      break;
    } else if ((typeBytes[0] & 32) === 0) throw new Error(`PNG critical chunk ${type} is unsupported.`);
    offset = end;
  }
  if (!ended || offset !== bytes.length || !header) throw new Error("PNG is incomplete or contains trailing data.");
  const rowBytes = header.width * header.channels;
  const expected = (rowBytes + 1) * header.height;
  let filtered;
  try { filtered = new Uint8Array(inflateSync(Buffer.concat(compressed), { maxOutputLength: expected })); } catch { throw new Error("PNG image data could not be safely decompressed."); }
  if (filtered.length !== expected) throw new Error("PNG decompressed size does not match its dimensions.");
  const pixels = new Uint8Array(rowBytes * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const inputStart = y * (rowBytes + 1);
    const outputStart = y * rowBytes;
    const filter = filtered[inputStart];
    if (filter > 4) throw new Error("PNG row uses an unsupported filter.");
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = filtered[inputStart + 1 + x];
      const left = x >= header.channels ? pixels[outputStart + x - header.channels] : 0;
      const above = y > 0 ? pixels[outputStart + x - rowBytes] : 0;
      const upperLeft = y > 0 && x >= header.channels ? pixels[outputStart + x - rowBytes - header.channels] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      pixels[outputStart + x] = (raw + prediction) & 255;
    }
  }
  if (header.channels === 4) return { width: header.width, height: header.height, rgba: pixels };
  const rgba = new Uint8Array(header.width * header.height * 4);
  for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) { rgba[target] = pixels[source]; rgba[target + 1] = pixels[source + 1]; rgba[target + 2] = pixels[source + 2]; rgba[target + 3] = 255; }
  return { width: header.width, height: header.height, rgba };
}
function uint32(bytes, offset) { return (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0); }
function crc32(...chunks) { let value = 0xffffffff; for (const chunk of chunks) for (const byte of chunk) { value ^= byte; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function paeth(left, above, upperLeft) { const estimate = left + above - upperLeft; const leftDistance = Math.abs(estimate - left); const aboveDistance = Math.abs(estimate - above); const diagonalDistance = Math.abs(estimate - upperLeft); return leftDistance <= aboveDistance && leftDistance <= diagonalDistance ? left : aboveDistance <= diagonalDistance ? above : upperLeft; }
function csv(value) { return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []; }
function number(value, label) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`); return parsed; }
function finiteNumber(value, label) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${label} must be between zero and one.`); return parsed; }
function required(value, message) { if (!value) throw new Error(message); return value; }
function requiredOption(value, name) { if (!value) throw new Error(`${name} is required.`); return value; }
