import { stripTypeScriptTypes } from "node:module";
import { transformTSX } from "./tsx.mjs";

export { transformTSX } from "./tsx.mjs";

/** Compile one TypeScript or TSX module without a package dependency. */
export function compile(source, options = {}) {
  const filename = options.filename ?? "module.ts";
  const transformed = filename.endsWith(".tsx")
    ? transformTSX(source, { importSource: options.jsxImportSource, filename, hydrationDiagnostics: options.hydrationDiagnostics }).code
    : source;
  const stripOnly = Number(process.versions.node.split(".")[0]) >= 26;
  let javascript;
  try {
    javascript = withoutStripTypesWarning(() => stripTypeScriptTypes(transformed, stripOnly
      ? { mode: "strip" }
      : {
        mode: "transform", sourceMap: options.sourceMap !== false,
        // Do not rename emitted files when measuring dist coverage.
        ...(options.sourceMap === false ? {} : { sourceUrl: filename }),
      }));
  } catch (error) {
    if (stripOnly && error?.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      throw new SyntaxError(`${filename}: ${error.message}. On Node 26 use erasable TypeScript: explicit constructor fields, object literals instead of enums, and ES modules instead of runtime namespaces. Node 22/24 retain transform support.`, { cause: error });
    }
    throw error;
  }
  // Strip mode preserves line positions. TSX maps to the lowered module just as
  // transform mode does; supply line mappings without the removed Node option.
  if (stripOnly && options.sourceMap !== false) {
    const map = { version: 3, sources: [filename], sourcesContent: [transformed], names: [],
      mappings: transformed.split("\n").map((_, index) => index ? "AACA" : "AAAA").join(";") };
    javascript += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
  }
  // Match each quoted specifier once. Searching for a .ts extension inside an
  // open-ended quoted region repeatedly backtracked on hostile editor input.
  javascript = javascript.replace(
    /(\bfrom\s+|\bimport\s*(?:\(\s*)?)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
    (match, prefix, literal) => {
      const specifier = literal.slice(1, -1);
      const suffixAt = specifier.search(/[?#]/u);
      const pathname = suffixAt < 0 ? specifier : specifier.slice(0, suffixAt);
      const suffix = suffixAt < 0 ? "" : specifier.slice(suffixAt);
      const extensionLength = pathname.endsWith(".tsx") ? 4 : pathname.endsWith(".ts") ? 3 : 0;
      if (!extensionLength) return match;
      return `${prefix}${literal[0]}${pathname.slice(0, -extensionLength)}.js${suffix}${literal[0]}`;
    },
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
