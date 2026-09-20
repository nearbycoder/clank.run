import { posix } from "node:path";

// Emitted browser modules use static imports or literal dynamic imports. Only walk
// that graph: server-only source must never become a public static asset.
const IMPORT_SPECIFIER = /(\bfrom\s+|\bimport\s*(?:\(\s*)?)(["'])([^"']+)\2/gu;

function importTarget(filename, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(filename), specifier));
  if (target.startsWith("../vendor/")) return { vendor: target.slice("../vendor/".length) };
  if (target.startsWith("../") || target.startsWith("/")) throw new Error(`Browser import escapes the documentation assets: ${specifier}`);
  return { module: target };
}

export function browserModulePaths(sources, entry = "app.js") {
  const visited = new Set();
  const visit = (filename) => {
    if (visited.has(filename)) return;
    const source = sources.get(filename);
    if (source === undefined) throw new Error(`Missing documentation browser module: ${filename}`);
    visited.add(filename);
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const target = importTarget(filename, match[3]);
      if (target?.module) visit(target.module);
    }
  };
  visit(entry);
  return [...visited].sort();
}

export function browserAssetName(filename, version) {
  return filename.includes("/")
    ? `${version}/${filename}`
    : filename.replace(/\.js$/u, `.${version}.js`);
}

export function versionBrowserImports(source, filename, version) {
  return source.replace(IMPORT_SPECIFIER, (match, prefix, quote, specifier) => {
    const target = importTarget(filename, specifier);
    if (!target) return match;
    const path = target.vendor
      ? `/vendor/${version}/${target.vendor}`
      : `/assets/${browserAssetName(target.module, version)}`;
    return `${prefix}${quote}${path}${quote}`;
  });
}

export function browserAssetCopies(sources, version) {
  return browserModulePaths(sources).map((filename) => ({
    asset: browserAssetName(filename, version),
    filename: `browser/${filename}`,
    source: versionBrowserImports(sources.get(filename), filename, version),
  }));
}
