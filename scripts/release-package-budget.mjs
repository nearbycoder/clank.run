// Private release-audit helper. Neither this module nor its manifest is shipped.
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;

function packagePath(value) {
  return typeof value === "string" && value.length > 0
    && !/[\\\u0000-\u0020\u007f:]/u.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function assertReleasePackageBudget(result, manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error("Release package manifest must contain sorted, unique, canonical paths.");
  }
  for (let index = 0; index < manifest.length; index++) {
    if (!packagePath(manifest[index]) || (index > 0 && manifest[index - 1] >= manifest[index])) {
      throw new Error("Release package manifest must contain sorted, unique, canonical paths.");
    }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !Array.isArray(result.files)
    || !Number.isSafeInteger(result.entryCount) || result.entryCount < 0
    || result.entryCount !== result.files.length
    || result.entryCount !== manifest.length) {
    throw new Error("Packed file count must match the exact release package manifest.");
  }
  if (!Number.isSafeInteger(result.unpackedSize) || result.unpackedSize < 0) {
    throw new Error("Packed unpacked size must be a nonnegative safe integer.");
  }
  const paths = new Set();
  let bytes = 0;
  for (const file of result.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)
      || !packagePath(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error("Packed files must have unique canonical paths and nonnegative safe sizes.");
    }
    paths.add(file.path);
    bytes += file.size;
    if (!Number.isSafeInteger(bytes)) throw new Error("Packed member sizes exceed the safe integer range.");
  }
  if (manifest.some((name) => !paths.has(name))) {
    throw new Error("Packed paths differ from the exact release package manifest.");
  }
  if (bytes !== result.unpackedSize) {
    throw new Error("Packed unpacked size differs from the sum of member sizes.");
  }
  if (bytes > MAX_UNPACKED_BYTES) {
    throw new Error("Published package unexpectedly exceeds 8 MiB unpacked.");
  }
  return Object.freeze({ files: paths.size, bytes });
}
