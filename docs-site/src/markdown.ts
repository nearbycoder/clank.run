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
    .replace(/<[^>]*>/gu, "")
    .replace(/[^a-z0-9\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-") || "section";
}

function safeHref(raw: string): { href: string; external: boolean } | null {
  const value = raw.trim();
  if (!value || value.startsWith("javascript:") || value.startsWith("data:") || value.startsWith("//")) return null;
  if (value.startsWith("#") || value.startsWith("/")) return { href: value, external: false };
  if (/^https?:\/\//u.test(value)) return { href: value, external: true };
  if (/^mailto:[^\s@]+@[^\s@]+$/u.test(value)) return { href: value, external: true };
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

function inline(source: string): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const id = `CLANKDOCSTOKEN${tokens.length}END`;
    tokens.push(html);
    return id;
  };
  let text = source.replace(/`([^`\n]+)`/gu, (_match, code: string) =>
    token(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_match, label: string, href: string) => {
    const target = safeHref(href);
    if (!target) return escapeHtml(label);
    const external = target.external ? " target=\"_blank\" rel=\"noreferrer\"" : "";
    return token(`<a href="${escapeHtml(target.href)}"${external}>${inline(label)}</a>`);
  });
  text = text.replace(/<(https?:\/\/[^>\s]+)>/gu, (_match, href: string) =>
    token(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(href)}</a>`));
  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/__([^_]+)__/gu, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/gu, "$1<em>$2</em>");
  for (let index = tokens.length - 1; index >= 0; index--) {
    text = text.replaceAll(`CLANKDOCSTOKEN${index}END`, tokens[index]);
  }
  return text;
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
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
    || (line.includes("|") && isTableDivider(next));
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
      html.push(
        `<figure class="code-block"><figcaption><span>${escapeHtml(language)}</span><button type="button" data-copy-code aria-label="Copy ${escapeHtml(language)} code">Copy</button></figcaption><pre><code class="language-${escapeHtml(language)}">${escapeHtml(code.join("\n"))}</code></pre></figure>`,
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
      html.push(`<h${level} id="${id}"><a class="heading-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inline(text)}</h${level}>`);
      index++;
      continue;
    }

    if (line.includes("|") && isTableDivider(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index++]));
      }
      html.push(`<div class="table-scroll"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_cell, cellIndex) => `<td>${inline(row[cellIndex] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
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
