import { highlightCode } from "./highlight.ts";

export interface TableOfContentsEntry {
  id: string;
  title: string;
  level: number;
}

export interface RenderedMarkdown {
  html: string;
  title: string;
  toc: TableOfContentsEntry[];
}

const GITHUB_ROOT = "https://github.com/nearbycoder/clank.run/blob/main/";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-") || "section";
}

function safeHref(raw: string): { href: string; external: boolean } | null {
  const value = raw.trim();
  if (!value || value.startsWith("//")) return null;
  if (value.startsWith("#") || value.startsWith("/")) return { href: value, external: false };
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    try {
      const url = new URL(value);
      return { href: url.href, external: true };
    } catch {
      return null;
    }
  }
  if (scheme === "mailto") {
    return /^mailto:[^\s@]+@[^\s@]+$/iu.test(value) ? { href: value, external: true } : null;
  }
  if (scheme) return null;
  const [path, fragment = ""] = value.split("#", 2);
  if (path.endsWith(".md") && !path.startsWith("../")) {
    const slug = path.split("/").at(-1)!.replace(/\.md$/u, "");
    return { href: `/docs/${encodeURIComponent(slug)}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`, external: false };
  }
  if (path.startsWith("../")) {
    const repositoryPath = path.replace(/^(\.\.\/)+/u, "");
    return { href: `${GITHUB_ROOT}${repositoryPath}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`, external: true };
  }
  return { href: `${GITHUB_ROOT}docs/${path}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`, external: true };
}

function closingBackticks(source: string, start: number, length: number): number {
  let index = start;
  while (index < source.length) {
    const next = source.indexOf("`", index);
    if (next < 0) break;
    index = next;
    while (source[index] === "`") index++;
    if (index - next === length) return next;
  }
  return -1;
}

function inline(source: string, textOnly = false): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const id = `CLANKDOCSTOKEN${tokens.length}END`;
    tokens.push(html);
    return id;
  };
  let text = "";
  for (let index = 0; index < source.length;) {
    if (source[index] === "\\") {
      text += source.slice(index, index + 2);
      index += 2;
    } else if (source[index] === "`") {
      let end = index;
      while (source[end] === "`") end++;
      const length = end - index;
      const close = closingBackticks(source, end, length);
      if (close < 0) {
        text += source.slice(index, end);
        index = end;
      } else {
        const code = escapeHtml(source.slice(end, close));
        text += token(textOnly ? code : `<code>${code}</code>`);
        index = close + length;
      }
    } else {
      text += source[index++];
    }
  }
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_match, label: string, href: string) => {
    const target = safeHref(href);
    if (!target) return escapeHtml(label);
    if (textOnly) return token(inline(label, true));
    const external = target.external ? " target=\"_blank\" rel=\"noreferrer\"" : "";
    return token(`<a href="${escapeHtml(target.href)}"${external}>${inline(label)}</a>`);
  });
  text = text.replace(/<(https?:\/\/[^>\s]+)>/gu, (_match, href: string) =>
    token(textOnly ? escapeHtml(href) : `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(href)}</a>`));
  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/gu, textOnly ? "$1" : "<strong>$1</strong>")
    .replace(/__([^_]+)__/gu, textOnly ? "$1" : "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/gu, textOnly ? "$1$2" : "$1<em>$2</em>");
  for (let index = tokens.length - 1; index >= 0; index--) {
    text = text.replaceAll(`CLANKDOCSTOKEN${index}END`, tokens[index]);
  }
  return text;
}

function tableCells(line: string): string[] {
  const source = line.trim();
  const cells: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length;) {
    if (source[index] === "\\") {
      // Skip escape pairs so an odd backslash count protects the following pipe.
      index += 2;
    } else if (source[index] === "`") {
      let end = index;
      while (source[end] === "`") end++;
      const length = end - index;
      const close = closingBackticks(source, end, length);
      index = close < 0 ? end : close + length;
    } else if (source[index] === "|") {
      cells.push(source.slice(start, index));
      start = ++index;
    } else {
      index++;
    }
  }
  if (!cells.length) return [];
  cells.push(source.slice(start));
  if (source.startsWith("|")) cells.shift();
  if (start === source.length) cells.pop();
  // Table pipe escapes apply to code spans too; preserve all other backslashes.
  return cells.map((cell) => cell.trim().replace(/(\\+)\|/gu, (match, slashes: string) =>
    slashes.length % 2 ? `${slashes.slice(1)}|` : match));
}

function isTableDivider(line: string, columns: number): boolean {
  const cells = tableCells(line);
  if (!cells.length) cells.push(line.trim());
  return cells.length === columns && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return /^\s*$/u.test(line)
    || /^#{1,6}\s+/u.test(line)
    || /^```/u.test(line)
    || /^>\s?/u.test(line)
    || /^\s*[-*+]\s+/u.test(line)
    || /^\s*\d+[.)]\s+/u.test(line)
    || /^([-*_])\1{2,}\s*$/u.test(line.trim())
    || isTableDivider(next, tableCells(line).length);
}

export function renderMarkdown(markdown: string): RenderedMarkdown {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const html: string[] = [];
  const toc: TableOfContentsEntry[] = [];
  const usedIds = new Map<string, number>();
  let title = "Documentation";
  let index = 0;

  const headingId = (value: string): string => {
    const base = slugPart(value);
    const count = usedIds.get(base) ?? 0;
    usedIds.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(/^```([A-Za-z0-9_+.-]*)\s*$/u);
    if (fence) {
      const language = fence[1] || "text";
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/u.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      const source = code.join("\n");
      html.push(
        `<figure class="code-block"><figcaption><span>${escapeHtml(language)}</span><button type="button" data-copy-code aria-label="Copy ${escapeHtml(language)} code">Copy</button></figcaption><pre tabindex="0"><code class="language-${escapeHtml(language)}">${highlightCode(source, language)}</code></pre></figure>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1 && title === "Documentation") {
        title = text;
        index++;
        continue;
      }
      const id = headingId(text);
      if (level <= 3) toc.push({ id, title: text, level });
      const content = inline(text);
      // Emit escaped text directly rather than stripping tags from generated markup.
      const label = inline(text, true);
      html.push(`<h${level} id="${id}"><a class="heading-anchor" href="#${id}" aria-label="Link to ${label}"><span aria-hidden="true">#</span></a>${content}</h${level}>`);
      index++;
      continue;
    }

    const headers = tableCells(line);
    if (isTableDivider(lines[index + 1] ?? "", headers.length)) {
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length) {
        const row = tableCells(lines[index]);
        if (!row.length) break;
        rows.push(row);
        index++;
      }
      html.push(`<div class="table-scroll" tabindex="0"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_cell, cellIndex) => `<td>${inline(row[cellIndex] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    if (/^>\s?/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/u, ""));
      html.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/u);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/u);
    if (unordered || ordered) {
      const tag = ordered ? "ol" : "ul";
      const matcher = ordered ? /^\s*\d+[.)]\s+(.+)$/u : /^\s*[-*+]\s+(.+)$/u;
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(matcher);
        if (!item) break;
        const parts = [item[1]];
        index++;
        while (index < lines.length && /^\s{2,}\S/u.test(lines[index]) && !/^\s*[-*+]\s+/u.test(lines[index]) && !/^\s*\d+[.)]\s+/u.test(lines[index])) {
          parts.push(lines[index].trim());
          index++;
        }
        items.push(`<li>${inline(parts.join(" "))}</li>`);
      }
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (/^([-*_])\1{2,}\s*$/u.test(line.trim())) {
      html.push("<hr>");
      index++;
      continue;
    }

    const paragraph = [line.trim()];
    index++;
    while (index < lines.length && !isBlockStart(lines, index)) paragraph.push(lines[index++].trim());
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return { html: html.join("\n"), title, toc };
}

export function markdownPlainText(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[`*_>#|~-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
