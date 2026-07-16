/**
 * Small, dependency-free TSX transform for Clank.
 *
 * It lowers JSX to Clank VNodes and wraps expression sites in compiler markers.
 * The runtime evaluates each marker in its own fine-grained reactive binding.
 */

const JSX = "__clankJSX";
const FRAGMENT = "__clankFragment";
const EXPR = "__clankExpression";

export function transformTSX(source, options = {}) {
  // Use a Clank-specific pragma so TypeScript does not try to resolve the
  // conventional jsx-runtime module while `jsx: preserve` is enabled.
  const importSource = source.match(/@clankImportSource\s+([^\s*]+)/)?.[1]
    ?? options.importSource
    ?? "clank.run";
  const state = { source, transformed: false };
  const code = transformRegion(state, 0, source.length);
  if (!state.transformed) return { code: source, transformed: false };
  const runtimeImport = `import { jsx as ${JSX}, Fragment as ${FRAGMENT}, expression as ${EXPR} } from ${JSON.stringify(importSource)};\n`;
  return { code: runtimeImport + code, transformed: true };
}

function transformRegion(state, start, end) {
  const { source } = state;
  let output = "";
  let index = start;
  while (index < end) {
    const literalEnd = skipLiteralOrComment(source, index);
    if (literalEnd > index) {
      output += source.slice(index, literalEnd);
      index = literalEnd;
      continue;
    }
    if (source[index] === "<" && looksLikeJSXStart(source, index, start)) {
      const parsed = parseElement(state, index);
      output += parsed.code;
      index = parsed.end;
      state.transformed = true;
      continue;
    }
    output += source[index++];
  }
  return output;
}

function looksLikeJSXStart(source, index, floor) {
  const next = source[index + 1];
  if (next !== ">" && !/[A-Za-z_$]/.test(next ?? "")) return false;
  if (next !== ">") {
    let generic = index + 1;
    while (/[A-Za-z0-9_$]/.test(source[generic] ?? "")) generic++;
    generic = skipSpace(source, generic);
    if (source[generic] === "," || source.startsWith("extends ", generic)) return false;
  }
  let previous = index - 1;
  while (previous >= floor && /\s/.test(source[previous])) previous--;
  if (previous < floor) return true;
  if (/[=(:,\[{!&|?;>]/.test(source[previous])) return true;
  let wordEnd = previous + 1;
  while (previous >= floor && /[A-Za-z]/.test(source[previous])) previous--;
  const word = source.slice(previous + 1, wordEnd);
  return word === "return" || word === "yield" || word === "case" || word === "else";
}

function parseElement(state, start) {
  const { source } = state;
  let index = start + 1;
  const fragment = source[index] === ">";
  let tag = "";
  if (fragment) index++;
  else {
    const tagStart = index;
    while (index < source.length && /[A-Za-z0-9_$.:\-]/.test(source[index])) index++;
    tag = source.slice(tagStart, index);
    if (!tag) throw syntaxError(source, start, "Expected a JSX tag name.");
  }

  const attributes = [];
  let selfClosing = false;
  if (!fragment) {
    while (index < source.length) {
      index = skipSpace(source, index);
      if (source.startsWith("/>", index)) {
        selfClosing = true;
        index += 2;
        break;
      }
      if (source[index] === ">") {
        index++;
        break;
      }
      if (source[index] === "{") {
        const balanced = readBalanced(source, index, "{", "}");
        const content = balanced.content.trim();
        if (!content.startsWith("...")) throw syntaxError(source, index, "Only spread attributes may omit a name.");
        attributes.push(`...(${transformRegion(state, balanced.innerStart + 3, balanced.innerEnd)})`);
        index = balanced.end;
        continue;
      }
      const nameStart = index;
      while (index < source.length && !/[\s=/>]/.test(source[index])) index++;
      const name = source.slice(nameStart, index);
      if (!name) throw syntaxError(source, index, "Expected a JSX attribute.");
      index = skipSpace(source, index);
      if (source[index] !== "=") {
        attributes.push(`${JSON.stringify(name)}: true`);
        continue;
      }
      index = skipSpace(source, index + 1);
      let value;
      if (source[index] === '"' || source[index] === "'") {
        const quote = source[index++];
        const valueStart = index;
        while (index < source.length && source[index] !== quote) {
          if (source[index] === "\\") index++;
          index++;
        }
        if (source[index] !== quote) throw syntaxError(source, valueStart, "Unterminated JSX attribute string.");
        value = JSON.stringify(decodeEntities(source.slice(valueStart, index)));
        index++;
      } else if (source[index] === "{") {
        const balanced = readBalanced(source, index, "{", "}");
        const raw = balanced.content.trim();
        if (!raw) throw syntaxError(source, index, `Attribute ${name} needs a value.`);
        const transformed = transformRegion(state, balanced.innerStart, balanced.innerEnd).trim();
        value = wrapAttribute(name, transformed);
        index = balanced.end;
      } else {
        const valueStart = index;
        while (index < source.length && !/[\s/>]/.test(source[index])) index++;
        value = JSON.stringify(source.slice(valueStart, index));
      }
      attributes.push(`${JSON.stringify(name)}: ${value}`);
    }
  }

  const children = [];
  if (!selfClosing) {
    while (index < source.length) {
      if (source.startsWith("</", index)) {
        index += 2;
        index = skipSpace(source, index);
        if (fragment) {
          if (source[index] !== ">") throw syntaxError(source, index, "Expected </> to close the fragment.");
          index++;
        } else {
          const closeStart = index;
          while (index < source.length && /[A-Za-z0-9_$.:\-]/.test(source[index])) index++;
          const closing = source.slice(closeStart, index);
          if (closing !== tag) throw syntaxError(source, closeStart, `Expected </${tag}> but found </${closing}>.`);
          index = skipSpace(source, index);
          if (source[index] !== ">") throw syntaxError(source, index, `Expected > after </${tag}.`);
          index++;
        }
        break;
      }
      if (source[index] === "<") {
        const child = parseElement(state, index);
        children.push(child.code);
        index = child.end;
        state.transformed = true;
        continue;
      }
      if (source[index] === "{") {
        const balanced = readBalanced(source, index, "{", "}");
        const raw = balanced.content.trim();
        if (raw && !/^\/\*[\s\S]*\*\/$/.test(raw) && !/^\/\//.test(raw)) {
          const transformed = transformRegion(state, balanced.innerStart, balanced.innerEnd).trim();
          children.push(wrapChild(transformed));
        }
        index = balanced.end;
        continue;
      }
      const textStart = index;
      while (index < source.length && source[index] !== "<" && source[index] !== "{") index++;
      const text = normalizeText(decodeEntities(source.slice(textStart, index)));
      if (text) children.push(JSON.stringify(text));
    }
  }

  if (!selfClosing && index >= source.length && !source.slice(start, index).includes(fragment ? "</>" : `</${tag}>`)) {
    throw syntaxError(source, start, `Unclosed JSX ${fragment ? "fragment" : `<${tag}>`}.`);
  }
  const type = fragment ? FRAGMENT : tagExpression(tag);
  const props = `{ ${attributes.join(", ")} }`;
  return {
    code: `${JSX}(${type}, ${props}${children.length ? `, ${children.join(", ")}` : ""})`,
    end: index,
  };
}

function wrapAttribute(name, code) {
  if (isLiteral(code) || isFunction(code) || code.startsWith(`${JSX}(`)) return code;
  if (name === "key" || name === "ref" || name === "use" || name === "dangerouslySetInnerHTML" || name.startsWith("bind:") || name.startsWith("on:") || /^on[A-Z]/.test(name)) return code;
  return `${EXPR}(() => (${code}))`;
}

function wrapChild(code) {
  if (isLiteral(code) || isFunction(code) || code.startsWith(`${JSX}(`)) return code;
  return `${EXPR}(() => (${code}))`;
}

function isFunction(code) {
  const input = code.trim();
  if (/^(?:async\s+)?function\b/.test(input)) return true;
  let index = 0;
  if (input.startsWith("async") && !/[A-Za-z0-9_$]/.test(input[5] ?? "")) index = skipSpace(input, 5);
  if (/[A-Za-z_$]/.test(input[index] ?? "")) {
    index++;
    while (/[A-Za-z0-9_$]/.test(input[index] ?? "")) index++;
    return input.startsWith("=>", skipSpace(input, index));
  }
  if (input[index] !== "(") return false;
  try {
    const parameters = readBalanced(input, index, "(", ")");
    index = skipSpace(input, parameters.end);
    if (input.startsWith("=>", index)) return true;
    if (input[index] !== ":") return false;
    return input.indexOf("=>", index + 1) !== -1;
  } catch {
    return false;
  }
}

function isLiteral(code) {
  return /^(?:true|false|null|undefined|NaN|Infinity|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|["'][\s\S]*["'])$/i.test(code);
}

function tagExpression(tag) {
  return /^[a-z]/.test(tag) || tag.includes("-") || tag.includes(":")
    ? JSON.stringify(tag)
    : tag;
}

function normalizeText(value) {
  const lines = value.replace(/\r/g, "").replace(/\t/g, " ").split("\n");
  if (lines.length === 1) return lines[0];
  const words = [];
  for (const line of lines) {
    const compact = line.trim().replace(/\s+/g, " ");
    if (compact) words.push(compact);
  }
  const text = words.join(" ");
  if (!text) return "";
  return `${/^\s/.test(value) ? " " : ""}${text}${/\s$/.test(value) ? " " : ""}`;
}

function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (entity, name) => ({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    "#39": "'",
  })[name] ?? entity);
}

function readBalanced(source, start, open, close) {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const skipped = skipLiteralOrComment(source, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (source[index] === open) depth++;
    else if (source[index] === close && --depth === 0) {
      return {
        content: source.slice(start + 1, index),
        innerStart: start + 1,
        innerEnd: index,
        end: index + 1,
      };
    }
    index++;
  }
  throw syntaxError(source, start, `Unclosed ${open}.`);
}

function skipLiteralOrComment(source, index) {
  const quote = source[index];
  if (quote === '"' || quote === "'" || quote === "`") {
    index++;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index] === quote) return index + 1;
      else index++;
    }
    return index;
  }
  if (source.startsWith("//", index)) {
    const end = source.indexOf("\n", index + 2);
    return end === -1 ? source.length : end;
  }
  if (source.startsWith("/*", index)) {
    const end = source.indexOf("*/", index + 2);
    return end === -1 ? source.length : end + 2;
  }
  return index;
}

function skipSpace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index++;
  return index;
}

function syntaxError(source, index, message) {
  const line = source.slice(0, index).split("\n").length;
  const column = index - source.lastIndexOf("\n", index - 1);
  return new SyntaxError(`${message} (${line}:${column})`);
}
