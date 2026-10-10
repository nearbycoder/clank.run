import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "./compiler.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let temporaryFile = 0;

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path));
    else if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not compiled: ${path}`);
    else output.push(path);
  }
  return output;
}

async function writeFileAtomically(outputPath, contents) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.clank-build-${process.pid}-${temporaryFile++}`;
  try {
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function compileFile(sourcePath, outputPath, options = {}) {
  const source = await readFile(sourcePath, "utf8");
  const sourceMap = options.sourceMap ?? process.env.CLANK_SOURCE_MAPS === "1";
  const javascript = compile(source, {
    filename: sourcePath,
    jsxImportSource: options.jsxImportSource,
    // Inline source maps duplicate most source text and made the published
    // zero-dependency package exceed its bounded release envelope. They remain
    // available explicitly for local debugging without bloating every install.
    sourceMap,
  });
  await writeFileAtomically(outputPath, options.releaseLayout && !sourceMap ? compactReleaseLayout(javascript) : javascript);
}

// This is deliberately private to the framework release build. Remove only
// leading horizontal indentation in known code regions; keep every token,
// comment/license, newline and literal byte. Ambiguity discards all edits for
// the module, and nested template scanning has a fixed bound. The public
// compiler, example output and mapped builds retain their format contract.
function compactReleaseLayout(source) {
  if (source.startsWith("#!")) return source;
  const parts = [];
  let copied = 0;
  const isWord = character => Boolean(character && /[\p{ID_Continue}$\u200c\u200d]/u.test(character));
  const isStart = character => Boolean(character && /[\p{ID_Start}$_]/u.test(character));
  const isLineEnd = character => /[\r\n\u2028\u2029]/u.test(character);
  const expressionWords = new Set(["return", "throw", "case", "default", "extends", "delete", "void", "typeof", "new", "instanceof", "in", "yield", "await", "else", "do"]);

  function quoted(start, quote) {
    for (let index = start + 1; index < source.length; index++) {
      const character = source[index];
      if (character === "\\") {
        if (source[index + 1] === "\r" && source[index + 2] === "\n") index += 2;
        else index++;
      } else if (character === quote) return index + 1;
      else if (isLineEnd(character)) return null;
    }
    return null;
  }

  function regexp(start, ambiguous, inTemplate) {
    let characterClass = false;
    for (let index = start + 1; index < source.length; index++) {
      const character = source[index];
      if (isLineEnd(character)) return null;
      // At a division/regexp boundary, skip only a single-line region which
      // cannot hide a quote, template, comment opener or template brace. Keep
      // the expression boundary ambiguous afterward rather than guessing.
      if (ambiguous && (/["'`]/u.test(character) || inTemplate && /[{}]/u.test(character))) return null;
      if (character === "\\") { index++; continue; }
      if (character === "[") {
        // Nested Unicode-v classes need a richer grammar; leave this module.
        if (characterClass) return null;
        characterClass = true;
      } else if (character === "]") characterClass = false;
      else if (character === "/" && !characterClass) {
        if (ambiguous && (source[index + 1] === "*" || source[index + 1] === "/")) return null;
        index++;
        while (isWord(source[index])) index++;
        return index;
      }
    }
    return null;
  }

  function template(start, depth) {
    if (depth > 64) return null;
    for (let index = start + 1; index < source.length;) {
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === "`") return index + 1;
      if (source[index] === "$" && source[index + 1] === "{") {
        const next = code(index + 2, true, depth + 1);
        if (next === null) return null;
        index = next;
      } else index++;
    }
    return null;
  }

  function code(start, inTemplate = false, depth = 0) {
    let expression = true;
    let previous = "";
    let braces = 0;
    for (let index = start; index < source.length;) {
      const character = source[index];
      if (character === " " || character === "\t") {
        let end = index + 1;
        while (source[end] === " " || source[end] === "\t") end++;
        if (index === 0 || isLineEnd(source[index - 1])) {
          parts.push(source.slice(copied, index));
          copied = end;
        }
        index = end;
        continue;
      }
      if (/\s/u.test(character)) { index++; continue; }
      if (character === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && !isLineEnd(source[index])) index++;
        continue;
      }
      if (character === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        if (end < 0) return null;
        index = end + 2;
        continue;
      }
      if (character === '"' || character === "'") {
        const next = quoted(index, character);
        if (next === null) return null;
        index = next; expression = false; previous = "literal";
        continue;
      }
      if (character === "`") {
        const next = template(index, depth);
        if (next === null) return null;
        index = next; expression = false; previous = "literal";
        continue;
      }
      if (character === "/") {
        if (expression === false) {
          index += source[index + 1] === "=" ? 2 : 1;
          expression = true; previous = "/";
          continue;
        }
        const ambiguous = expression === "ambiguous";
        const next = regexp(index, ambiguous, inTemplate);
        if (next === null) return null;
        index = next; expression = ambiguous ? "ambiguous" : false; previous = "literal";
        continue;
      }
      // Escaped identifiers obscure keyword/property context. Keep them exact.
      if (character === "\\") return null;
      const point = String.fromCodePoint(source.codePointAt(index));
      if (isStart(point)) {
        let end = index + point.length;
        while (end < source.length) {
          const next = String.fromCodePoint(source.codePointAt(end));
          if (!isWord(next)) break;
          end += next.length;
        }
        const word = source.slice(index, end);
        const property = previous === "." || previous === "#";
        // break/continue and an optional label can end at a newline. A regexp
        // on the next statement must not be mistaken for arithmetic division.
        const restricted = !property && (word === "break" || word === "continue" || word === "debugger" || previous === "break" || previous === "continue");
        // `of` is both a normal identifier and a for-of separator. Neither
        // context can justify interpreting its next slash as a proven regexp.
        expression = restricted || !property && word === "of" ? "ambiguous" : !property && expressionWords.has(word);
        previous = property ? "word" : word;
        index = end;
        continue;
      }
      if (/[0-9]/u.test(character)) {
        let end = index + 1;
        while (end < source.length && /[\w.]/u.test(source[end])) end++;
        index = end; expression = false; previous = "literal";
        continue;
      }
      if (character === "{") { if (inTemplate) braces++; expression = true; }
      else if (character === "}") {
        if (inTemplate && braces === 0) return index + 1;
        if (inTemplate) braces--;
        expression = "ambiguous";
      } else if (character === ")") expression = "ambiguous";
      else if (character === "]") expression = false;
      else if (character === "." && source[index + 1] !== ".") expression = false;
      else if ((character === "+" || character === "-") && source[index + 1] === character) index++; // Preserve prefix/postfix expectation.
      else expression = true;
      previous = character;
      index++;
    }
    return inTemplate ? null : source.length;
  }

  if (code(0) === null) return source;
  parts.push(source.slice(copied));
  return parts.join("");
}

export async function build({ quiet = false } = {}) {
  const started = performance.now();
  const sourceRoot = join(projectRoot, "src");
  const outputRoot = join(projectRoot, "dist");
  await mkdir(outputRoot, { recursive: true });
  const sources = await filesUnder(sourceRoot);
  const expectedOutputs = new Set();
  for (const path of sources) {
    const output = join(outputRoot, relative(sourceRoot, path));
    if (path.endsWith(".d.ts")) {
      expectedOutputs.add(output);
      await writeFileAtomically(output, await readFile(path));
    } else if (/\.tsx?$/.test(path)) {
      const javascriptOutput = output.replace(/\.tsx?$/, ".js");
      expectedOutputs.add(javascriptOutput);
      await compileFile(path, javascriptOutput, { jsxImportSource: "./index.js", releaseLayout: true });
    }
  }
  // Ship the same canonical prompt with the platform and the documentation site.
  const gettingStarted = await readFile(join(projectRoot, "docs/getting-started.md"), "utf8");
  const setupSection = gettingStarted.split("\n## Set up with an agent\n")[1]?.split("\n## ")[0];
  const prompts = [...(setupSection ?? "").matchAll(/^```text\n([\s\S]*?)\n```$/gmu)];
  if (prompts.length !== 1 || !prompts[0][1].trim()) {
    throw new Error("Getting Started must contain one complete agent setup prompt.");
  }
  const promptOutput = join(outputRoot, "agent-setup-prompt.js");
  expectedOutputs.add(promptOutput);
  await writeFileAtomically(promptOutput, `export const agentSetupPrompt = ${JSON.stringify(prompts[0][1])};\n`);
  for (const path of await filesUnder(outputRoot)) {
    if (!path.includes(".clank-build-") && !expectedOutputs.has(path)) await rm(path, { force: true });
  }

  const exampleRoot = join(projectRoot, "examples");
  for (const path of await filesUnder(exampleRoot)) {
    if (/\.tsx?$/.test(path)) await compileFile(path, path.replace(/\.tsx?$/, ".js"), { jsxImportSource: "/dist/index.js" });
  }
  if (!quiet) console.log(`Built Clank in ${(performance.now() - started).toFixed(1)}ms (zero dependencies).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}
