/* @clankImportSource ../vendor/dom.js */
import { readFile } from "node:fs/promises";
import {
  For,
  createApp,
  html,
  json,
  renderDocument,
  securityHeaders,
  serve,
  staticFiles,
  text,
} from "../vendor/index.js";
import { escapeHtml, markdownPlainText, renderMarkdown, type TableOfContentsEntry } from "./markdown.ts";
import { SearchBox, type SearchEntry } from "./search.tsx";

interface DocMetadata extends SearchEntry {
  source: string;
  groupId: string;
  words: number;
  readingMinutes: number;
}

interface DocGroup {
  id: string;
  title: string;
  description: string;
  slugs: string[];
}

interface Manifest {
  protocol: "clank-docs/1";
  frameworkVersion: string;
  assetVersion: string;
  groups: DocGroup[];
  docs: DocMetadata[];
}

interface DocumentationPage extends DocMetadata {
  markdown: string;
  text: string;
  html: string;
  toc: TableOfContentsEntry[];
}

interface PageOptions {
  title: string;
  description: string;
  path: string;
  activeSlug?: string;
  toc?: TableOfContentsEntry[];
  status?: number;
  initialQuery?: string;
}

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const canonicalOrigin = (environment?.DOCS_ORIGIN ?? "https://docs.clank.run").replace(/\/+$/u, "");
const distRoot = decodeURIComponent(new URL("./", import.meta.url).pathname);
const contentRoot = decodeURIComponent(new URL("../content/", import.meta.url).pathname);
const vendorRoot = decodeURIComponent(new URL("../vendor/", import.meta.url).pathname);
const manifest = JSON.parse(await readFile(`${contentRoot}manifest.json`, "utf8")) as Manifest;
const docs = await Promise.all(manifest.docs.map(async (metadata) => {
  const markdown = await readFile(`${contentRoot}${metadata.slug}.md`, "utf8");
  const rendered = renderMarkdown(markdown);
  return {
    ...metadata,
    markdown,
    text: markdownPlainText(markdown),
    html: rendered.html,
    toc: rendered.toc,
  } satisfies DocumentationPage;
}));
const docsBySlug = new Map(docs.map((doc) => [doc.slug, doc]));
const searchEntries: SearchEntry[] = docs.map(({ slug, title, description, groupTitle, headings }) => ({
  slug,
  title,
  description,
  groupTitle,
  headings,
}));
const appFiles = staticFiles(distRoot, { cacheControl: "public, max-age=31536000, immutable" });
const vendorFiles = staticFiles(vendorRoot, { prefix: "/vendor", cacheControl: "public, max-age=31536000, immutable" });

function versionedAsset(request: Request, filename: string): Response | Promise<Response> {
  const expected = new Map([
    [`app.${manifest.assetVersion}.js`, "app.js"],
    [`search.${manifest.assetVersion}.js`, "search.js"],
    [`styles.${manifest.assetVersion}.css`, "styles.css"],
  ]);
  const target = expected.get(filename);
  if (!target) return text("Asset not found.\n", { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${target}`;
  url.search = "";
  return appFiles.handle(new Request(url, { headers: request.headers }));
}

function groupFor(slug: string | undefined): DocGroup | undefined {
  return manifest.groups.find((group) => slug && group.slugs.includes(slug));
}

function Navigation(props: { activeSlug?: string }) {
  return (
    <nav class="docs-navigation" aria-label="Documentation">
      <a class="nav-home" href="/" aria-current={!props.activeSlug ? "page" : undefined}>
        <span class="nav-home-mark" aria-hidden="true">↗</span>
        <span><strong>Documentation</strong><small>Clank {manifest.frameworkVersion}</small></span>
      </a>
      <For each={manifest.groups} by="id">
        {(group) => (
          <section class="nav-group">
            <h2>{group.title}</h2>
            <For each={group.slugs} by={(slug) => slug}>
              {(slug) => {
                const doc = docsBySlug.get(slug)!;
                return (
                  <a
                    href={`/docs/${slug}`}
                    class={props.activeSlug === slug ? "active" : ""}
                    aria-current={props.activeSlug === slug ? "page" : undefined}
                  >
                    {doc.title}
                  </a>
                );
              }}
            </For>
          </section>
        )}
      </For>
    </nav>
  );
}

function TableOfContents(props: { entries: TableOfContentsEntry[] }) {
  return (
    <aside class="toc" aria-label="On this page">
      <strong>On this page</strong>
      <nav>
        <For each={props.entries} by="id" fallback={<span class="toc-empty">Overview</span>}>
          {(entry) => <a class={`toc-level-${entry.level}`} href={`#${entry.id}`}>{entry.title}</a>}
        </For>
      </nav>
      <div class="toc-agent">
        <span>Agent formats</span>
        <a href="/llms.txt">llms.txt</a>
        <a href="/llms-full.txt">full corpus</a>
        <a href="/api/docs.json">JSON index</a>
      </div>
    </aside>
  );
}

function SiteChrome(props: {
  activeSlug?: string;
  toc?: TableOfContentsEntry[];
  initialQuery?: string;
  children: unknown;
}) {
  return (
    <>
      <a class="skip-link" href="#main-content">Skip to content</a>
      <header class="site-header">
        <div class="header-inner">
          <button id="nav-toggle" class="nav-toggle" type="button" aria-label="Open documentation navigation" aria-controls="docs-sidebar" aria-expanded="false">☰</button>
          <a class="wordmark" href="/" agentLabel="Clank documentation home">
            <span>clank</span><span class="wordmark-docs">docs</span>
          </a>
          <div id="docs-search" class="header-search">
            <SearchBox entries={searchEntries} initialQuery={props.initialQuery} />
          </div>
          <nav class="header-links" aria-label="Project">
            <a href="/docs/getting-started">Get started</a>
            <a href="https://github.com/nearbycoder/clank.run" target="_blank" rel="noreferrer">GitHub ↗</a>
          </nav>
        </div>
      </header>
      <div class="docs-shell">
        <aside class="sidebar" id="docs-sidebar"><Navigation activeSlug={props.activeSlug} /></aside>
        <button class="nav-scrim" id="nav-scrim" type="button" aria-label="Close documentation navigation" hidden />
        <main class="main-content" id="main-content">{props.children}</main>
        <TableOfContents entries={props.toc ?? []} />
      </div>
      <footer class="site-footer">
        <span>Clank is an open-source, AI-first TypeScript framework.</span>
        <span><a href="/docs/security">Security</a><a href="/docs/contributing">Contribute</a><a href="/llms.txt">For agents</a></span>
      </footer>
    </>
  );
}

function HomePage() {
  return (
    <div class="home">
      <section class="home-hero">
        <div class="home-eyebrow"><span /> Framework and deployment platform</div>
        <h1>Build software that<br /><em>explains itself.</em></h1>
        <p>Clank is a dependency-free, full-stack TypeScript framework designed for people and coding agents. Start with one command, keep live SQLite state, and deploy the complete application through the same open-source control plane.</p>
        <div class="hero-actions">
          <a class="primary-action" href="/docs/getting-started">Start building <span>→</span></a>
          <a class="secondary-action" href="/docs/cli">Deploy with the CLI</a>
        </div>
        <div class="install-command">
          <span class="command-prompt">$</span>
          <code>clank create my-app</code>
          <button type="button" data-copy-text="clank create my-app" aria-label="Copy create command">Copy</button>
        </div>
      </section>

      <section class="home-proof" aria-label="Framework properties">
        <article><strong>0</strong><span>runtime dependencies</span></article>
        <article><strong>1</strong><span>typed app contract</span></article>
        <article><strong>Live</strong><span>cross-session updates</span></article>
        <article><strong>Atomic</strong><span>deploy and rollback</span></article>
      </section>

      <section class="home-section">
        <div class="section-heading">
          <span>01 / Mental model</span>
          <h2>One stack, end to end.</h2>
          <p>The browser, server, database, agent contract, and deployment artifact share the same explicit TypeScript model.</p>
        </div>
        <div class="architecture-map">
          <a href="/docs/rendering"><small>UI</small><strong>Signals + TSX</strong><span>Fine-grained DOM updates</span></a>
          <span class="map-arrow">→</span>
          <a href="/docs/full-stack"><small>Server</small><strong>Fetch + SSR</strong><span>Typed routes and hydration</span></a>
          <span class="map-arrow">→</span>
          <a href="/docs/database"><small>Data</small><strong>SQLite + revisions</strong><span>Transactional live queries</span></a>
          <span class="map-arrow">→</span>
          <a href="/docs/deployment-platform"><small>Ship</small><strong>Verified releases</strong><span>Migrate, health-check, activate</span></a>
        </div>
      </section>

      <section class="home-section">
        <div class="section-heading">
          <span>02 / Choose a path</span>
          <h2>Documentation with an opinion.</h2>
          <p>Each guide states the contract, safe defaults, failure boundaries, and commands an agent can execute.</p>
        </div>
        <div class="path-grid">
          <a href="/docs/getting-started"><span>Start</span><strong>Create the first app</strong><p>Project shape, compiler, examples, and the shortest path to a working full-stack application.</p><i>Read the guide →</i></a>
          <a href="/docs/architecture"><span>Understand</span><strong>See how Clank works</strong><p>Reactive graph, rendering, backend contracts, SQLite revisions, and runtime boundaries.</p><i>Read the guide →</i></a>
          <a href="/docs/cli"><span>Deploy</span><strong>Ship from the terminal</strong><p>Login, projects, secrets, migrations, verified artifacts, logs, backups, and rollback.</p><i>Read the guide →</i></a>
          <a href="/docs/blueprints"><span>Generate</span><strong>Build with an agent</strong><p>Static blueprints, deterministic plans, agent-readable help, and reproducible generation.</p><i>Read the guide →</i></a>
        </div>
      </section>

      <section class="agent-banner">
        <div>
          <span class="home-eyebrow"><span /> Machine-readable by default</span>
          <h2>Give your agent the whole framework.</h2>
          <p>Use the compact map for routing, the complete corpus for grounding, or the JSON endpoints for precise retrieval.</p>
        </div>
        <div class="agent-links">
          <a href="/llms.txt"><code>/llms.txt</code><span>Concise guide map →</span></a>
          <a href="/llms-full.txt"><code>/llms-full.txt</code><span>Complete documentation →</span></a>
          <a href="/api/docs.json"><code>/api/docs.json</code><span>Structured index →</span></a>
        </div>
      </section>

      <section class="home-section guide-directory">
        <div class="section-heading">
          <span>03 / Complete reference</span>
          <h2>Every maintained guide.</h2>
          <p>{docs.length} documents and {docs.reduce((sum, doc) => sum + doc.words, 0).toLocaleString()} words, built directly from the repository.</p>
        </div>
        <div class="directory-grid">
          <For each={manifest.groups} by="id">
            {(group) => (
              <article>
                <div><span>{String(group.slugs.length).padStart(2, "0")}</span><h3>{group.title}</h3></div>
                <p>{group.description}</p>
                <ul>
                  <For each={group.slugs.slice(0, 5)} by={(slug) => slug}>
                    {(slug) => <li><a href={`/docs/${slug}`}>{docsBySlug.get(slug)!.title}<span>→</span></a></li>}
                  </For>
                </ul>
              </article>
            )}
          </For>
        </div>
      </section>
    </div>
  );
}

function DocPage(props: { doc: DocumentationPage }) {
  const index = docs.findIndex((entry) => entry.slug === props.doc.slug);
  const previous = index > 0 ? docs[index - 1] : undefined;
  const next = index < docs.length - 1 ? docs[index + 1] : undefined;
  return (
    <article class="doc-page">
      <header class="doc-header">
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          <a href="/">Docs</a><span>/</span><span>{groupFor(props.doc.slug)?.title}</span>
        </nav>
        <h1>{props.doc.title}</h1>
        <p>{props.doc.description}</p>
        <div class="doc-meta">
          <span>{props.doc.readingMinutes} min read</span>
          <span>{props.doc.words.toLocaleString()} words</span>
          <span>Clank {manifest.frameworkVersion}</span>
        </div>
        <div class="doc-formats">
          <a href={`/raw/${props.doc.slug}.md`}>Raw Markdown</a>
          <a href={`/api/docs/${props.doc.slug}.json`}>JSON</a>
          <a href={`https://github.com/nearbycoder/clank.run/edit/main/${props.doc.source}`} target="_blank" rel="noreferrer">Edit on GitHub ↗</a>
        </div>
      </header>
      <div class="markdown" dangerouslySetInnerHTML={{ __html: props.doc.html }} />
      <aside class="agent-note">
        <strong>Using an agent?</strong>
        <p>The raw source for this page is available at <code>/raw/{props.doc.slug}.md</code>. The complete framework corpus is at <a href="/llms-full.txt">/llms-full.txt</a>.</p>
      </aside>
      <nav class="page-navigation" aria-label="Adjacent guides">
        {previous
          ? <a href={`/docs/${previous.slug}`}><small>Previous</small><strong>← {previous.title}</strong></a>
          : <span />}
        {next
          ? <a class="next" href={`/docs/${next.slug}`}><small>Next</small><strong>{next.title} →</strong></a>
          : <span />}
      </nav>
    </article>
  );
}

function scoreSearch(doc: DocumentationPage, query: string): number {
  const terms = query.toLowerCase().split(/\s+/u).filter((term) => term.length > 1);
  if (!terms.length) return 0;
  const title = doc.title.toLowerCase();
  const headings = doc.headings.join(" ").toLowerCase();
  const body = doc.text.toLowerCase();
  return terms.reduce((score, term) =>
    score
    + (title.includes(term) ? 40 : 0)
    + (headings.includes(term) ? 15 : 0)
    + Math.min(8, body.split(term).length - 1), 0);
}

function searchSnippet(doc: DocumentationPage, query: string): string {
  const term = query.toLowerCase().split(/\s+/u).find((entry) => entry.length > 1) ?? "";
  const index = term ? doc.text.toLowerCase().indexOf(term) : -1;
  const start = Math.max(0, index < 0 ? 0 : index - 90);
  const end = Math.min(doc.text.length, start + 260);
  return `${start > 0 ? "…" : ""}${doc.text.slice(start, end).trim()}${end < doc.text.length ? "…" : ""}`;
}

function SearchPage(props: { query: string }) {
  const results = props.query
    ? docs.map((doc) => ({ doc, score: scoreSearch(doc, props.query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.doc.title.localeCompare(right.doc.title))
    : [];
  return (
    <section class="search-page">
      <div class="breadcrumbs"><a href="/">Docs</a><span>/</span><span>Search</span></div>
      <h1>{props.query ? `Search results for “${props.query}”` : "Search all documentation"}</h1>
      <p>{props.query ? `${results.length} matching guide${results.length === 1 ? "" : "s"} across the complete documentation corpus.` : "Enter a framework concept, CLI command, API, or operational task."}</p>
      <div class="search-results">
        <For each={results} by={(entry) => entry.doc.slug} fallback={<div class="no-results"><strong>No matching guides</strong><span>Try a shorter term, an exact API name, or browse the categories in the navigation.</span></div>}>
          {(result) => (
            <a href={`/docs/${result.doc.slug}`}>
              <span>{result.doc.groupTitle}</span>
              <h2>{result.doc.title}</h2>
              <p>{searchSnippet(result.doc, props.query)}</p>
              <small>{result.doc.readingMinutes} min read · Open guide →</small>
            </a>
          )}
        </For>
      </div>
    </section>
  );
}

function NotFoundPage() {
  return (
    <section class="not-found">
      <span>404</span>
      <h1>This page is not in the contract.</h1>
      <p>Use search, return to the documentation map, or inspect the machine-readable index.</p>
      <div class="hero-actions"><a class="primary-action" href="/">Documentation home</a><a class="secondary-action" href="/api/docs.json">JSON index</a></div>
    </section>
  );
}

async function page(view: unknown, options: PageOptions): Promise<Response> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const canonical = `${canonicalOrigin}${options.path}`;
  const document = await renderDocument(
    <SiteChrome activeSlug={options.activeSlug} toc={options.toc} initialQuery={options.initialQuery}>{view}</SiteChrome>,
    {
      title: options.title === "Clank Documentation" ? options.title : `${options.title} · Clank Documentation`,
      bodyClass: "site-body",
      nonce,
      stylesheets: [`/assets/styles.${manifest.assetVersion}.css`],
      state: { search: searchEntries, initialQuery: options.initialQuery ?? "" },
      head: (
        <>
          <meta name="description" content={options.description} />
          <meta name="theme-color" content="#0a0a0a" />
          <meta name="robots" content={options.status === 404 ? "noindex" : "index,follow"} />
          <link rel="canonical" href={canonical} />
          <link rel="alternate" type="text/plain" href="/llms.txt" title="Agent documentation map" />
          <meta property="og:title" content={options.title} />
          <meta property="og:description" content={options.description} />
          <meta property="og:type" content="website" />
          <meta property="og:url" content={canonical} />
          <script
            type="module"
            nonce={nonce}
            dangerouslySetInnerHTML={{
              __html: `import("/assets/app.${manifest.assetVersion}.js").catch((error) => console.error("Clank Docs enhancement failed to load.", error))`,
            }}
          />
        </>
      ),
    },
  );
  return html(document, {
    status: options.status ?? 200,
    headers: {
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      "content-security-policy": [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join("; "),
    },
  });
}

function llmsIndex(): string {
  const output = [
    "# Clank",
    "",
    "> An AI-first, dependency-free full-stack TypeScript framework and open-source deployment platform.",
    "",
    `Canonical documentation: ${canonicalOrigin}`,
    `Framework version: ${manifest.frameworkVersion}`,
    "",
    "## Agent entry points",
    "",
    `- [Complete documentation corpus](${canonicalOrigin}/llms-full.txt)`,
    `- [Structured documentation index](${canonicalOrigin}/api/docs.json)`,
    `- [Getting started](${canonicalOrigin}/docs/getting-started)`,
    `- [Deployment CLI](${canonicalOrigin}/docs/cli)`,
    `- [API reference](${canonicalOrigin}/docs/api-reference)`,
    "",
  ];
  for (const group of manifest.groups) {
    output.push(`## ${group.title}`, "", group.description, "");
    for (const slug of group.slugs) {
      const doc = docsBySlug.get(slug)!;
      output.push(`- [${doc.title}](${canonicalOrigin}/raw/${slug}.md): ${doc.description}`);
    }
    output.push("");
  }
  output.push(
    "## CLI discovery",
    "",
    "- `clank help --json` returns the stable machine-readable command manifest.",
    "- `clank doctor --json` returns structured project-readiness diagnostics.",
    "- Prefer raw Markdown or JSON endpoints when exact commands and contracts matter.",
    "",
  );
  return output.join("\n");
}

function llmsFull(): string {
  return [
    "# Clank complete documentation",
    "",
    `Source: ${canonicalOrigin}`,
    `Framework version: ${manifest.frameworkVersion}`,
    "",
    ...docs.flatMap((doc) => [
      "---",
      "",
      `# ${doc.title}`,
      "",
      `Canonical URL: ${canonicalOrigin}/docs/${doc.slug}`,
      `Raw source: ${canonicalOrigin}/raw/${doc.slug}.md`,
      "",
      doc.markdown.replace(/^#\s+.+$/mu, "").trim(),
      "",
    ]),
  ].join("\n");
}

const app = createApp({
  onError(error) {
    console.error("Documentation request failed.", error instanceof Error ? error.message : "Unknown error");
  },
})
  .use(securityHeaders({ contentSecurityPolicy: false }))
  .get("/healthz", () => json({ ok: true, service: "clank-docs", version: manifest.frameworkVersion }, {
    headers: { "cache-control": "no-store" },
  }))
  .get("/", () => page(<HomePage />, {
    title: "Clank Documentation",
    description: "Build, understand, secure, and deploy applications with the AI-first Clank TypeScript framework.",
    path: "/",
  }))
  .get("/docs", () => new Response(null, { status: 308, headers: { location: "/docs/getting-started" } }))
  .get("/docs/:slug", ({ params, url }) => {
    if (url.pathname.endsWith("/")) {
      return new Response(null, {
        status: 308,
        headers: { location: `${url.pathname.slice(0, -1)}${url.search}` },
      });
    }
    const doc = docsBySlug.get(params.slug);
    return doc
      ? page(<DocPage doc={doc} />, {
        title: doc.title,
        description: doc.description,
        path: `/docs/${doc.slug}`,
        activeSlug: doc.slug,
        toc: doc.toc,
      })
      : page(<NotFoundPage />, {
        title: "Not found",
        description: "The requested Clank documentation page does not exist.",
        path: `/docs/${encodeURIComponent(params.slug)}`,
        status: 404,
      });
  })
  .get("/search", ({ url }) => {
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    return page(<SearchPage query={query} />, {
      title: query ? `Search: ${query}` : "Search",
      description: "Search the complete Clank framework and deployment documentation.",
      path: query ? `/search?q=${encodeURIComponent(query)}` : "/search",
      initialQuery: query,
    });
  })
  .get("/raw/:filename", ({ params }) => {
    const slug = params.filename.replace(/\.md$/u, "");
    const doc = docsBySlug.get(slug);
    return doc
      ? text(doc.markdown, {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-disposition": `inline; filename="${slug}.md"`,
          "x-robots-tag": "noindex",
        },
      })
      : text("Documentation not found.\n", { status: 404 });
  })
  .get("/api/docs.json", () => json({
    protocol: manifest.protocol,
    frameworkVersion: manifest.frameworkVersion,
    canonicalOrigin,
    agentEndpoints: {
      compact: `${canonicalOrigin}/llms.txt`,
      full: `${canonicalOrigin}/llms-full.txt`,
      rawPattern: `${canonicalOrigin}/raw/{slug}.md`,
      documentPattern: `${canonicalOrigin}/api/docs/{slug}.json`,
    },
    groups: manifest.groups,
    docs: manifest.docs.map((doc) => ({
      ...doc,
      url: `${canonicalOrigin}/docs/${doc.slug}`,
      raw: `${canonicalOrigin}/raw/${doc.slug}.md`,
      json: `${canonicalOrigin}/api/docs/${doc.slug}.json`,
    })),
  }, { headers: { "cache-control": "public, max-age=3600" } }))
  .get("/api/docs/:filename", ({ params }) => {
    const slug = params.filename.replace(/\.json$/u, "");
    const doc = docsBySlug.get(slug);
    return doc
      ? json({
        protocol: "clank-doc/1",
        frameworkVersion: manifest.frameworkVersion,
        slug: doc.slug,
        title: doc.title,
        description: doc.description,
        group: { id: doc.groupId, title: doc.groupTitle },
        url: `${canonicalOrigin}/docs/${doc.slug}`,
        source: doc.source,
        headings: doc.headings,
        tableOfContents: doc.toc,
        markdown: doc.markdown,
      }, { headers: { "cache-control": "public, max-age=3600" } })
      : json({ error: { code: "DOC_NOT_FOUND", message: "Documentation not found." } }, { status: 404 });
  })
  .get("/llms.txt", () => text(llmsIndex(), { headers: { "cache-control": "public, max-age=3600" } }))
  .get("/llms-full.txt", () => text(llmsFull(), { headers: { "cache-control": "public, max-age=3600" } }))
  .get("/robots.txt", () => text(`User-agent: *\nAllow: /\nSitemap: ${canonicalOrigin}/sitemap.xml\n`))
  .get("/sitemap.xml", () => {
    const urls = ["/", ...docs.map((doc) => `/docs/${doc.slug}`)];
    const left = String.fromCharCode(60);
    const xml = `${left}?xml version="1.0" encoding="UTF-8"?>${left}urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((path) => `${left}url>${left}loc>${escapeHtml(`${canonicalOrigin}${path}`)}${left}/loc>${left}/url>`).join("")}${left}/urlset>`;
    return new Response(xml, {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  })
  .get("/assets/:filename", ({ request, params }) => versionedAsset(request, params.filename))
  .get("/vendor/*", ({ request }) => vendorFiles.handle(request))
  .route("*", "*", ({ url }) => {
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      return new Response(null, { status: 308, headers: { location: `${url.pathname.slice(0, -1)}${url.search}` } });
    }
    return page(<NotFoundPage />, {
      title: "Not found",
      description: "The requested Clank documentation page does not exist.",
      path: url.pathname,
      status: 404,
    });
  });

const server = await serve(app, {
  hostname: environment?.HOST ?? "127.0.0.1",
  port: Number(environment?.PORT ?? 4300),
  trustProxy: environment?.TRUST_PROXY === "1",
  allowedHosts: environment?.ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
});

console.log(`Clank Documentation: ${server.url}`);
