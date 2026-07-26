type TokenKind =
  | "attribute"
  | "comment"
  | "function"
  | "keyword"
  | "literal"
  | "number"
  | "operator"
  | "property"
  | "string"
  | "tag"
  | "type"
  | "variable";

interface LanguageDefinition {
  blockComment?: readonly [string, string];
  caseInsensitive?: boolean;
  commands?: boolean;
  flags?: boolean;
  hyphenatedWords?: boolean;
  jsx?: boolean;
  keywords: ReadonlySet<string>;
  lineComments: readonly string[];
  literals: ReadonlySet<string>;
  properties?: boolean;
  quotes: ReadonlySet<string>;
  types: ReadonlySet<string>;
  variables?: boolean;
}

const words = (value: string): ReadonlySet<string> => new Set(value.split(/\s+/u).filter(Boolean));
const EMPTY = new Set<string>();
const JS_KEYWORDS = words("as async await break case catch class const continue debugger declare default delete do else export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of override private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield");
const JS_TYPES = words("Array bigint boolean Date Error Map never number object Promise Record RegExp Set string symbol unknown void");
const SHELL_KEYWORDS = words("case do done elif else esac export fi for function if in local readonly select set then time trap until while");
const SQL_KEYWORDS = words("add alter and as asc begin between by case check column commit constraint create database default delete desc distinct drop else end exists foreign from full grant group having if in index inner insert into is join key left like limit not null offset on or order outer primary references release rename replace return returning right rollback savepoint select set table then transaction trigger union unique update values view when where");

const DEFINITIONS: Record<string, LanguageDefinition> = {
  javascript: {
    blockComment: ["/*", "*/"],
    jsx: true,
    keywords: JS_KEYWORDS,
    lineComments: ["//"],
    literals: words("false null true undefined"),
    quotes: new Set(["\"", "'", "`"]),
    types: JS_TYPES,
  },
  json: {
    keywords: EMPTY,
    lineComments: [],
    literals: words("false null true"),
    properties: true,
    quotes: new Set(["\""]),
    types: EMPTY,
  },
  jsonc: {
    blockComment: ["/*", "*/"],
    keywords: EMPTY,
    lineComments: ["//"],
    literals: words("false null true"),
    properties: true,
    quotes: new Set(["\"", "'"]),
    types: EMPTY,
  },
  shell: {
    commands: true,
    flags: true,
    hyphenatedWords: true,
    keywords: SHELL_KEYWORDS,
    lineComments: ["#"],
    literals: words("false true"),
    quotes: new Set(["\"", "'", "`"]),
    types: EMPTY,
    variables: true,
  },
  sql: {
    blockComment: ["/*", "*/"],
    caseInsensitive: true,
    keywords: SQL_KEYWORDS,
    lineComments: ["--"],
    literals: words("false null true"),
    quotes: new Set(["\"", "'", "`"]),
    types: words("bigint blob boolean char date decimal float int integer json numeric real text timestamp varchar"),
  },
  css: {
    blockComment: ["/*", "*/"],
    hyphenatedWords: true,
    keywords: words("and from important media not only or supports to var"),
    lineComments: [],
    literals: words("inherit initial none revert transparent unset"),
    properties: true,
    quotes: new Set(["\"", "'"]),
    types: EMPTY,
    variables: true,
  },
  config: {
    hyphenatedWords: true,
    keywords: EMPTY,
    lineComments: ["#"],
    literals: words("false null off on true yes no"),
    properties: true,
    quotes: new Set(["\"", "'"]),
    types: EMPTY,
    variables: true,
  },
  mermaid: {
    hyphenatedWords: true,
    keywords: words("classDef click end flowchart graph linkStyle sequenceDiagram stateDiagram subgraph"),
    lineComments: ["%%"],
    literals: words("false null true"),
    quotes: new Set(["\"", "'"]),
    types: EMPTY,
  },
};

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "shell",
  caddyfile: "shell",
  cjs: "javascript",
  dotenv: "config",
  ini: "config",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  sh: "shell",
  toml: "config",
  ts: "javascript",
  tsx: "javascript",
  typescript: "javascript",
  yaml: "config",
  yml: "config",
  zsh: "shell",
};

function escapeCode(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function token(kind: TokenKind, value: string): string {
  return `<span class="tok-${kind}">${escapeCode(value)}</span>`;
}

function wordStart(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z_$]/u.test(character));
}

function wordPart(character: string | undefined, hyphenated: boolean): boolean {
  return Boolean(character && (/[A-Za-z0-9_$]/u.test(character) || (hyphenated && character === "-")));
}

function nextNonWhitespace(source: string, start: number): string {
  let index = start;
  while (index < source.length && /\s/u.test(source[index])) index++;
  return source[index] ?? "";
}

function previousNonWhitespace(source: string, start: number): string {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(source[index])) index--;
  return source[index] ?? "";
}

function quotedEnd(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function variableEnd(source: string, start: number): number {
  if (source[start + 1] === "{") {
    const end = source.indexOf("}", start + 2);
    return end === -1 ? source.length : end + 1;
  }
  if (source[start + 1] === "(") {
    const end = source.indexOf(")", start + 2);
    return end === -1 ? source.length : end + 1;
  }
  let index = start + 1;
  while (index < source.length && /[A-Za-z0-9_@*#?$!-]/u.test(source[index])) index++;
  return index === start + 1 ? start + 1 : index;
}

function highlightedString(source: string, start: number, end: number, variables: boolean): string {
  if (!variables || source[start] === "'") return token("string", source.slice(start, end));
  const output: string[] = [];
  let cursor = start;
  let index = start + 1;
  while (index < end) {
    if (source[index] !== "$" || source[index - 1] === "\\") {
      index++;
      continue;
    }
    const variableBoundary = variableEnd(source, index);
    if (variableBoundary === index + 1 || variableBoundary > end) {
      index++;
      continue;
    }
    if (cursor < index) output.push(token("string", source.slice(cursor, index)));
    output.push(token("variable", source.slice(index, variableBoundary)));
    cursor = variableBoundary;
    index = variableBoundary;
  }
  if (cursor < end) output.push(token("string", source.slice(cursor, end)));
  return output.join("");
}

function normalizedWord(definition: LanguageDefinition, value: string): string {
  return definition.caseInsensitive ? value.toLowerCase() : value;
}

function highlightGeneric(source: string, definition: LanguageDefinition): string {
  const output: string[] = [];
  let index = 0;
  let statementStart = true;
  let inJsxTag = false;

  while (index < source.length) {
    const character = source[index];

    if (/\s/u.test(character)) {
      output.push(character);
      if (character === "\n") statementStart = true;
      index++;
      continue;
    }

    const lineComment = definition.lineComments.find((prefix) =>
      source.startsWith(prefix, index)
      && (prefix !== "#" || index === 0 || /\s/u.test(source[index - 1])));
    if (lineComment) {
      const end = source.indexOf("\n", index);
      const boundary = end === -1 ? source.length : end;
      output.push(token("comment", source.slice(index, boundary)));
      index = boundary;
      continue;
    }

    if (definition.blockComment && source.startsWith(definition.blockComment[0], index)) {
      const closing = source.indexOf(definition.blockComment[1], index + definition.blockComment[0].length);
      const end = closing === -1 ? source.length : closing + definition.blockComment[1].length;
      output.push(token("comment", source.slice(index, end)));
      index = end;
      continue;
    }

    if (definition.jsx && character === "<") {
      const match = source.slice(index).match(/^<\/?([A-Za-z][A-Za-z0-9_.:-]*)/u);
      const previous = previousNonWhitespace(source, index);
      if (match && (!previous || /[=({[,;:>!]/u.test(previous) || /\s/u.test(source[index - 1] ?? ""))) {
        const prefix = match[0].startsWith("</") ? "</" : "<";
        output.push(token("operator", prefix), token("tag", match[1]));
        index += match[0].length;
        inJsxTag = true;
        statementStart = false;
        continue;
      }
    }

    if (inJsxTag && (source.startsWith("/>", index) || character === ">")) {
      const value = source.startsWith("/>", index) ? "/>" : ">";
      output.push(token("operator", value));
      index += value.length;
      inJsxTag = false;
      continue;
    }

    if (definition.quotes.has(character)) {
      const end = quotedEnd(source, index, character);
      const kind = definition.properties && (nextNonWhitespace(source, end) === ":" || nextNonWhitespace(source, end) === "=")
        ? "property"
        : null;
      output.push(kind
        ? token(kind, source.slice(index, end))
        : highlightedString(source, index, end, definition.variables === true));
      index = end;
      statementStart = false;
      continue;
    }

    if (definition.variables && character === "$") {
      const end = variableEnd(source, index);
      if (end > index + 1) {
        output.push(token("variable", source.slice(index, end)));
        index = end;
        statementStart = false;
        continue;
      }
    }

    if (definition.flags && character === "-" && /[A-Za-z-]/u.test(source[index + 1] ?? "")) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_-]/u.test(source[end])) end++;
      output.push(token("attribute", source.slice(index, end)));
      index = end;
      statementStart = false;
      continue;
    }

    const number = source.slice(index).match(/^(?:0[xob][0-9a-f_]+|\d[\d_]*(?:\.[\d_]+)?(?:e[+-]?\d+)?)(?:[a-z%]+)?/iu);
    if (number) {
      output.push(token("number", number[0]));
      index += number[0].length;
      statementStart = false;
      continue;
    }

    if (wordStart(character)) {
      let end = index + 1;
      while (end < source.length && wordPart(source[end], definition.hyphenatedWords === true)) end++;
      const value = source.slice(index, end);
      const normalized = normalizedWord(definition, value);
      const next = nextNonWhitespace(source, end);
      const previous = previousNonWhitespace(source, index);
      let kind: TokenKind | null = null;
      if (inJsxTag) kind = "attribute";
      else if (definition.keywords.has(normalized)) kind = "keyword";
      else if (definition.literals.has(normalized)) kind = "literal";
      else if (definition.properties && (next === ":" || next === "=")) kind = "property";
      else if (previous === ".") kind = "property";
      else if (next === "(") kind = "function";
      else if (definition.types.has(normalized) || /^[A-Z][A-Za-z0-9_$]*$/u.test(value)) kind = "type";
      else if (definition.commands && statementStart) kind = next === "=" ? "variable" : "function";
      output.push(kind ? token(kind, value) : escapeCode(value));
      index = end;
      statementStart = false;
      continue;
    }

    if (/[{}\[\]():;,.=+\-*/%!?&|<>~^]/u.test(character)) {
      let end = index + 1;
      while (end < source.length && /[=+\-*/%!?&|<>~^]/u.test(source[end])) end++;
      const value = source.slice(index, end);
      output.push(token("operator", value));
      if (/[;|]/u.test(value)) statementStart = true;
      index = end;
      continue;
    }

    output.push(escapeCode(character));
    statementStart = false;
    index++;
  }

  return output.join("");
}

function highlightMarkup(source: string): string {
  const output: string[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const closing = source.indexOf("-->", index + 4);
      const end = closing === -1 ? source.length : closing + 3;
      output.push(token("comment", source.slice(index, end)));
      index = end;
      continue;
    }
    if (source[index] !== "<") {
      output.push(escapeCode(source[index++]));
      continue;
    }
    const match = source.slice(index).match(/^(<\/?|<!)([A-Za-z][A-Za-z0-9:.-]*)/u);
    if (!match) {
      output.push("&lt;");
      index++;
      continue;
    }
    output.push(token("operator", match[1]), token("tag", match[2]));
    index += match[0].length;
    while (index < source.length && source[index] !== ">") {
      const character = source[index];
      if (/\s/u.test(character)) {
        output.push(character);
        index++;
      } else if (character === "\"" || character === "'") {
        const end = quotedEnd(source, index, character);
        output.push(token("string", source.slice(index, end)));
        index = end;
      } else if (wordStart(character)) {
        let end = index + 1;
        while (end < source.length && /[A-Za-z0-9_:.-]/u.test(source[end])) end++;
        output.push(token("attribute", source.slice(index, end)));
        index = end;
      } else {
        output.push(token("operator", character));
        index++;
      }
    }
    if (source[index] === ">") {
      output.push(token("operator", ">"));
      index++;
    }
  }
  return output.join("");
}

export function highlightCode(source: string, rawLanguage: string): string {
  const language = rawLanguage.trim().toLowerCase();
  const normalized = LANGUAGE_ALIASES[language] ?? language;
  if (normalized === "html" || normalized === "xml" || normalized === "svg") {
    return highlightMarkup(source);
  }
  const definition = DEFINITIONS[normalized];
  return definition ? highlightGeneric(source, definition) : escapeCode(source);
}
