import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function diagnosticKey(ts, diagnostic, directory = root) {
  const file = diagnostic.file ? relative(directory, diagnostic.file.fileName).replaceAll("\\", "/") : "<compiler>";
  return `${file}|TS${diagnostic.code}|${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").replace(/\s+/gu, " ").trim()}`;
}
export function newDiagnostics(keys, baseline) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].filter(([key, count]) => count > (baseline[key] ?? 0));
}

export async function verifyTypeContracts({ typescript, typeRoots }) {
  if (!typescript || !typeRoots) throw new Error("Supply --typescript /trusted/typescript/lib/typescript.js and --type-roots /trusted/node_modules/@types. The framework never installs its own compiler.");
  const ts = (await import(pathToFileURL(resolve(typescript)).href)).default;
  const baseline = JSON.parse(await readFile(join(root, "type-tests/semantic-baseline.json"), "utf8"));
  const nodeVersion = JSON.parse(await readFile(join(resolve(typeRoots), "node/package.json"), "utf8")).version;
  if (ts.version !== baseline.typescript || nodeVersion !== baseline.nodeTypes) throw new Error(`Semantic baseline requires TypeScript ${baseline.typescript} and @types/node ${baseline.nodeTypes}; found ${ts.version}/${nodeVersion}.`);
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, " "));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { typeRoots: [resolve(typeRoots)] });
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  const added = newDiagnostics(diagnostics.map(diagnostic => diagnosticKey(ts, diagnostic)), baseline.diagnostics);
  if (added.length) throw new Error(`New semantic diagnostics:\n${added.map(([key, count]) => `${count} × ${key}`).join("\n")}`);
  console.log(`Source types: ${diagnostics.length} existing diagnostics, no new diagnostics (baseline ${Object.values(baseline.diagnostics).reduce((sum, count) => sum + count, 0)}).`);

  const directory = await mkdtemp(join(tmpdir(), "clank-type-contracts-"));
  const command = (name, args, cwd) => {
    const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  try {
    const packed = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], root));
    const pack = Array.isArray(packed) ? packed : Object.values(packed);
    if (pack.length !== 1 || typeof pack[0].filename !== "string") throw new Error("Expected exactly one packed framework artifact.");
    await writeFile(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
    command("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", "--offline", join(directory, pack[0].filename)], directory);
    const files = [];
    for (const name of (await readdir(join(root, "type-tests"))).filter(name => /\.tsx?$/u.test(name))) {
      const source = (await readFile(join(root, "type-tests", name), "utf8"))
        .replace(/(["'])\.\.\/(?:src|dist)\/index\.(?:ts|js)\1/gu, '"@clank.run/framework"')
        .replace(/(["'])\.\.\/src\/([a-z0-9-]+)\.ts\1/gu, '"@clank.run/framework/$2"');
      const destination = join(directory, name); await writeFile(destination, source); files.push(destination);
    }
    const consumer = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve, strict: true, noEmit: true,
      skipLibCheck: false, typeRoots: [resolve(typeRoots)], types: ["node"], lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    });
    const failures = ts.getPreEmitDiagnostics(consumer);
    if (failures.length) throw new Error(`Packed consumer contracts failed:\n${ts.formatDiagnosticsWithColorAndContext(failures, { getCurrentDirectory: () => directory, getCanonicalFileName: value => value, getNewLine: () => "\n" })}`);
    console.log(`Packed consumer types: ${files.length} positive/negative fixtures and all imported declarations passed.`);
    const runtimeFixture = join(directory, "packed-openapi.mjs");
    await writeFile(runtimeFixture, await readFile(join(root, "tests/fixtures/packed-openapi.mjs")));
    command(process.execPath, ["--disable-warning=ExperimentalWarning", runtimeFixture], directory);
    console.log("Packed OpenAPI examples: accepted/rejected requests matched the exported runtime contract.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  await verifyTypeContracts({ typescript: args.includes("--typescript") ? option("--typescript") : process.env.CLANK_TYPESCRIPT_PATH,
    typeRoots: args.includes("--type-roots") ? option("--type-roots") : process.env.CLANK_TYPE_ROOTS });
}
