import { stripTypeScriptTypes } from "node:module";
import { transformTSX } from "./tsx.mjs";

export { transformTSX } from "./tsx.mjs";

/** Compile one TypeScript or TSX module without a package dependency. */
export function compile(source, options = {}) {
  const filename = options.filename ?? "module.ts";
  const transformed = filename.endsWith(".tsx")
    ? transformTSX(source, { importSource: options.jsxImportSource }).code
    : source;
  let javascript = withoutStripTypesWarning(() =>
    stripTypeScriptTypes(transformed, {
      mode: "transform",
      sourceMap: options.sourceMap !== false,
      sourceUrl: filename,
    }));
  javascript = javascript.replace(
    /(\bfrom\s+|\bimport\s*(?:\(\s*)?)(["'])([^"']+?)\.tsx?([?#][^"']*)?\2/g,
    (_match, prefix, quote, specifier, suffix = "") => `${prefix}${quote}${specifier}.js${suffix}${quote}`,
  );
  return javascript;
}

function withoutStripTypesWarning(operation) {
  const emitWarning = process.emitWarning;
  process.emitWarning = function filteredWarning(warning, ...details) {
    const options = details[0];
    const type = typeof options === "string" ? options : options?.type;
    if (type === "ExperimentalWarning"
      && String(warning).includes("stripTypeScriptTypes")) return;
    return Reflect.apply(emitWarning, this, [warning, ...details]);
  };
  try {
    return operation();
  } finally {
    process.emitWarning = emitWarning;
  }
}
