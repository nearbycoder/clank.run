import { stripTypeScriptTypes } from "node:module";
import { transformTSX } from "./tsx.mjs";

export { transformTSX } from "./tsx.mjs";

/** Compile one TypeScript or TSX module without a package dependency. */
export function compile(source, options = {}) {
  const filename = options.filename ?? "module.ts";
  const transformed = filename.endsWith(".tsx")
    ? transformTSX(source, { importSource: options.jsxImportSource }).code
    : source;
  let javascript = stripTypeScriptTypes(transformed, {
    mode: "transform",
    sourceMap: options.sourceMap !== false,
    sourceUrl: filename,
  });
  javascript = javascript.replace(
    /(\bfrom\s+|\bimport\s*(?:\(\s*)?)(["'])([^"']+?)\.tsx?([?#][^"']*)?\2/g,
    (_match, prefix, quote, specifier, suffix = "") => `${prefix}${quote}${specifier}.js${suffix}${quote}`,
  );
  return javascript;
}
