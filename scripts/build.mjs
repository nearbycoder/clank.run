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
  await writeFileAtomically(outputPath, options.releaseLayout && !sourceMap ? compactReleaseLayout(javascript, options.preserveInteriorSpacing) : javascript);
}

// This is deliberately private to the framework release build. Remove only
// horizontal indentation and spacing beside standalone separators in known
// code regions; keep every token,
// comment/license, newline and literal byte. Ambiguity discards all edits for
// the module, and nested template scanning has a fixed bound. The public
// compiler, example output and mapped builds retain their format contract.
function compactReleaseLayout(source, preserveInteriorSpacing = false) {
  if (source.startsWith("#!")) return source;
  const edits = [];
  let interiorSafe = !preserveInteriorSpacing;
  const len = source.length;
  const isAsciiStart = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95;
  const isAsciiWord = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 36 || c === 95;
  const isWord = character => {
    if (!character) return false;
    const c = character.charCodeAt(0);
    return c < 128 ? isAsciiWord(c) : /[\p{ID_Continue}$\u200c\u200d]/u.test(character);
  };
  const isStart = character => {
    if (!character) return false;
    const c = character.charCodeAt(0);
    return c < 128 ? isAsciiStart(c) : /[\p{ID_Start}$_]/u.test(character);
  };
  const isLineEndCode = c => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
  const isLineEnd = character => Boolean(character && isLineEndCode(character.charCodeAt(0)));
  const isSeparatorCode = c => c === 59 || c === 44 || c === 58 || c === 40 || c === 41 || c === 91 || c === 93 || c === 123 || c === 125;
  const expressionWords = new Set(["return", "throw", "case", "default", "extends", "delete", "void", "typeof", "new", "instanceof", "in", "yield", "await", "else", "do"]);

  // A regexp literal cannot cross a line terminator; without another slash
  // on this line, division is certain. Declaration types have no regex literals.
  function noClosingSlash(start) {
    for (let index = start + 1; index < len; index++) {
      const c = source.charCodeAt(index);
      if (isLineEndCode(c)) return true;
      if (c === 47) return false;
    }
    return true;
  }

  function quoted(start, quoteCode) {
    for (let index = start + 1; index < len; index++) {
      const c = source.charCodeAt(index);
      if (c === 92) {
        if (source.charCodeAt(index + 1) === 13 && source.charCodeAt(index + 2) === 10) index += 2;
        else index++;
      } else if (c === quoteCode) return index + 1;
      else if (isLineEndCode(c)) return null;
    }
    return null;
  }

  function regexp(start, ambiguous, inTemplate) {
    let characterClass = false;
    for (let index = start + 1; index < len; index++) {
      const c = source.charCodeAt(index);
      if (isLineEndCode(c)) return null;
      // At a division/regexp boundary, skip only a single-line region which
      // cannot hide a quote, template, comment opener or template brace. Keep
      // the expression boundary ambiguous afterward rather than guessing.
      if (ambiguous && (c === 34 || c === 39 || c === 96 || (inTemplate && (c === 123 || c === 125)))) return null;
      if (c === 92) { index++; continue; }
      if (c === 91) {
        // Nested Unicode-v classes need a richer grammar; leave this module.
        if (characterClass) return null;
        characterClass = true;
      } else if (c === 93) characterClass = false;
      else if (c === 47 && !characterClass) {
        const nextC = source.charCodeAt(index + 1);
        if (ambiguous && (nextC === 42 || nextC === 47)) return null;
        index++;
        while (index < len && isWord(source[index])) index++;
        return index;
      }
    }
    return null;
  }

  function template(start, depth) {
    if (depth > 64) return null;
    for (let index = start + 1; index < len;) {
      const c = source.charCodeAt(index);
      if (c === 92) { index += 2; continue; }
      if (c === 96) return index + 1;
      if (c === 36 && source.charCodeAt(index + 1) === 123) {
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
    for (let index = start; index < len;) {
      const c = source.charCodeAt(index);
      if (c === 32 || c === 9) {
        let end = index + 1;
        while (end < len && (source.charCodeAt(end) === 32 || source.charCodeAt(end) === 9)) end++;
        // These single-character separators cannot combine with a neighbour
        // into a different token. Keep other spacing, including numeric dots,
        // identifier/keyword boundaries, and adjacent operator characters.
        // Newlines remain untouched, so ASI and restricted productions keep
        // their original line terminators. Literals/comments bypass this path.
        const leading = index === 0 || isLineEndCode(source.charCodeAt(index - 1));
        if (leading || (index > 0 && isSeparatorCode(source.charCodeAt(index - 1))) || (end < len && isSeparatorCode(source.charCodeAt(end)))) {
          edits.push({ start: index, end, leading });
        }
        index = end;
        continue;
      }
      if (c === 10 || c === 13 || c === 11 || c === 12 || (c >= 128 && /\s/u.test(source[index]))) { index++; continue; }
      if (c === 47) {
        const nextC = source.charCodeAt(index + 1);
        if (nextC === 47) {
          index += 2;
          while (index < len && !isLineEndCode(source.charCodeAt(index))) index++;
          continue;
        }
        if (nextC === 42) {
          const end = source.indexOf("*/", index + 2);
          if (end < 0) return null;
          index = end + 2;
          continue;
        }
        if (expression === false || expression === "ambiguous" && noClosingSlash(index)) {
          index += nextC === 61 ? 2 : 1;
          expression = true; previous = "/";
          continue;
        }
        const ambiguous = expression === "ambiguous";
        // The existing indentation scan may skip an ambiguous single-line
        // division/regexp region. Its trailing context is not sufficient to
        // classify interior literal spaces, so discard ALL interior edits for
        // this module, including edits queued before the ambiguity appeared.
        if (ambiguous) interiorSafe = false;
        const next = regexp(index, ambiguous, inTemplate);
        if (next === null) return null;
        index = next; expression = ambiguous ? "ambiguous" : false; previous = "literal";
        continue;
      }
      if (c === 34 || c === 39) {
        const next = quoted(index, c);
        if (next === null) return null;
        index = next; expression = false; previous = "literal";
        continue;
      }
      if (c === 96) {
        const next = template(index, depth);
        if (next === null) return null;
        index = next; expression = false; previous = "literal";
        continue;
      }
      // Escaped identifiers obscure keyword/property context. Keep them exact.
      if (c === 92) return null;
      if (c < 128 ? isAsciiStart(c) : isStart(String.fromCodePoint(source.codePointAt(index)))) {
        let end = c < 128 ? index + 1 : index + String.fromCodePoint(source.codePointAt(index)).length;
        while (end < len) {
          const nc = source.charCodeAt(end);
          if (nc < 128) {
            if (!isAsciiWord(nc)) break;
            end++;
          } else {
            const next = String.fromCodePoint(source.codePointAt(end));
            if (!isWord(next)) break;
            end += next.length;
          }
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
      if (c >= 48 && c <= 57) {
        let end = index + 1;
        while (end < len) {
          const nc = source.charCodeAt(end);
          if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || nc === 95 || nc === 46) end++;
          else break;
        }
        index = end; expression = false; previous = "literal";
        continue;
      }
      const character = source[index];
      if (c === 123) { if (inTemplate) braces++; expression = true; }
      else if (c === 125) {
        if (inTemplate && braces === 0) return index + 1;
        if (inTemplate) braces--;
        expression = "ambiguous";
      } else if (c === 41) expression = "ambiguous";
      else if (c === 93) expression = false;
      else if (c === 46 && source.charCodeAt(index + 1) !== 46) expression = false;
      else if ((c === 43 || c === 45) && source.charCodeAt(index + 1) === c) index++; // Preserve prefix/postfix expectation.
      else expression = true;
      previous = character;
      index++;
    }
    return inTemplate ? null : len;
  }

  if (code(0) === null) return source;
  const parts = [];
  let copied = 0;
  for (const edit of edits) {
    if (!edit.leading && !interiorSafe) continue;
    parts.push(source.slice(copied, edit.start));
    copied = edit.end;
  }
  parts.push(source.slice(copied));
  return parts.join("");
}

// Private Buffer-in/Buffer-out build/audit contract, not a package export.
// Mapped copies and malformed UTF-8 stay byte-exact. Eligible declarations
// remove code indentation/separator spacing, retaining every literal/comment byte.
export function declarationReleaseLayout(source, { sourceMap = process.env.CLANK_SOURCE_MAPS === "1" } = {}) {
  if (sourceMap) return source;
  const text = source.toString("utf8");
  if (!Buffer.from(text).equals(source)) return source;
  return Buffer.from(compactReleaseLayout(text, false));
}

export async function build({ quiet = false } = {}) {
  const started = performance.now();
  const sourceRoot = join(projectRoot, "src");
  const outputRoot = join(projectRoot, "dist");
  await mkdir(outputRoot, { recursive: true });
  const sources = await filesUnder(sourceRoot);
  const expectedOutputs = new Set();
  const tasks = [];
  for (const path of sources) {
    const output = join(outputRoot, relative(sourceRoot, path));
    if (path.endsWith(".d.ts")) {
      expectedOutputs.add(output);
      tasks.push(async () => writeFileAtomically(output, declarationReleaseLayout(await readFile(path))));
    } else if (/\.tsx?$/.test(path)) {
      const javascriptOutput = output.replace(/\.tsx?$/, ".js");
      expectedOutputs.add(javascriptOutput);
      const preserve = relative(sourceRoot, path) === "jobs.ts";
      tasks.push(() => compileFile(path, javascriptOutput, { jsxImportSource: "./index.js", releaseLayout: true,
        preserveInteriorSpacing: preserve }));
    }
  }
  const runConcurrent = async (items, limit = 8) => {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await items[cursor++]();
    });
    await Promise.all(workers);
  };
  await runConcurrent(tasks);
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
  const exampleTasks = (await filesUnder(exampleRoot))
    .filter((path) => /\.tsx?$/.test(path))
    .map((path) => () => compileFile(path, path.replace(/\.tsx?$/, ".js"), { jsxImportSource: "/dist/index.js" }));
  await runConcurrent(exampleTasks);
  if (!quiet) console.log(`Built Clank in ${(performance.now() - started).toFixed(1)}ms (zero dependencies).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}
