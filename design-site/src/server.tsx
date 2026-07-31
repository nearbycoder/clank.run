/* @clankImportSource ../vendor/dom.js */
import { readFile } from "node:fs/promises";
import {
  CLANK_THEME_PRESETS,
  MCP_PROTOCOL_VERSION,
  McpToolError,
  UI_COMPONENT_CATALOG,
  UI_COMPONENT_COUNT,
  createApp,
  createMcpServer,
  html,
  json,
  renderDocument,
  securityHeaders,
  serve,
  staticFiles,
  text,
} from "../vendor/index.js";
import { DesignStudio, type StudioView } from "./studio.js";

interface Manifest {
  protocol: "clank-design/1";
  frameworkVersion: string;
  assetVersion: string;
  vendorVersion: string;
  componentCount: number;
  themeCount: number;
}

const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const canonicalOrigin = (environment?.DESIGN_ORIGIN ?? "https://design.clank.run").replace(/\/+$/u, "");
const distRoot = decodeURIComponent(new URL("./", import.meta.url).pathname);
const vendorRoot = decodeURIComponent(new URL("../vendor/", import.meta.url).pathname);
const manifest = JSON.parse(await readFile(`${distRoot}manifest.json`, "utf8")) as Manifest;
const appFiles = staticFiles(distRoot, { cacheControl: "public, max-age=31536000, immutable" });
const vendorFiles = staticFiles(vendorRoot, { prefix: "/vendor", cacheControl: "public, max-age=31536000, immutable" });

function componentRecord(entry: (typeof UI_COMPONENT_CATALOG)[number]) {
  return {
    ...entry,
    url: `${canonicalOrigin}/components/${entry.slug}`,
    import: `@clank.run/framework/ui/${entry.slug}`,
  };
}

function themeRecord(theme: (typeof CLANK_THEME_PRESETS)[number], includeTokens = false) {
  return {
    protocol: theme.protocol,
    id: theme.id,
    name: theme.name,
    description: theme.description,
    scheme: theme.scheme,
    tags: theme.tags,
    url: `${canonicalOrigin}/themes#${theme.id}`,
    ...(includeTokens ? { tokens: theme.tokens } : {}),
  };
}

function inputObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpToolError("INVALID_INPUT", "Tool arguments must be an object.");
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new McpToolError("INVALID_INPUT", `Unexpected argument: ${unexpected}.`);
  return input;
}

const designMcp = createMcpServer({
  name: "clank-design",
  title: "Clank Design Studio",
  version: manifest.frameworkVersion,
  description: "Inspect Clank's complete headless component catalog and dependency-free theme presets.",
  instructions: "Use design.components or design.themes to discover the system, then read one exact contract with design.component or design.theme. All tools are public and read-only.",
  allowedOrigins: [canonicalOrigin],
  tools: [
    {
      name: "design.components",
      title: "List components",
      description: "List all 37 Clank UI families, optionally filtered by implementation module.",
      inputSchema: { type: "object", properties: { module: { type: "string", maxLength: 32 } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { total: { type: "integer" }, components: { type: "array", items: { type: "object" } } }, required: ["total", "components"], additionalProperties: false },
      annotations: { title: "List components", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      invoke(value) {
        const input = inputObject(value, ["module"]);
        if (input.module !== undefined && (typeof input.module !== "string" || input.module.length > 32)) throw new McpToolError("INVALID_INPUT", "module must be a bounded string.");
        const selected = input.module ? UI_COMPONENT_CATALOG.filter((entry) => entry.module === input.module) : UI_COMPONENT_CATALOG;
        return { total: selected.length, components: selected.map(componentRecord) };
      },
    },
    {
      name: "design.component",
      title: "Read component contract",
      description: "Read one component's factory, package subpath, semantic parts, and live specimen URL.",
      inputSchema: { type: "object", properties: { slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 } }, required: ["slug"], additionalProperties: false },
      outputSchema: { type: "object", properties: { component: { type: "object" } }, required: ["component"], additionalProperties: false },
      annotations: { title: "Read component contract", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      invoke(value) {
        const input = inputObject(value, ["slug"]);
        if (typeof input.slug !== "string" || input.slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.slug)) throw new McpToolError("INVALID_INPUT", "slug must be a canonical component slug.");
        const entry = UI_COMPONENT_CATALOG.find((candidate) => candidate.slug === input.slug);
        if (!entry) throw new McpToolError("COMPONENT_NOT_FOUND", "The requested component does not exist.");
        return { component: componentRecord(entry) };
      },
    },
    {
      name: "design.themes",
      title: "List themes",
      description: "List all ten dependency-free Clank theme presets and their visual intent.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: { total: { type: "integer" }, themes: { type: "array", items: { type: "object" } } }, required: ["total", "themes"], additionalProperties: false },
      annotations: { title: "List themes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      invoke(value) { inputObject(value, []); return { total: CLANK_THEME_PRESETS.length, themes: CLANK_THEME_PRESETS.map((theme) => themeRecord(theme)) }; },
    },
    {
      name: "design.theme",
      title: "Read theme tokens",
      description: "Read one preset's complete typed token map for use in an application or generator.",
      inputSchema: { type: "object", properties: { id: { type: "string", pattern: "^[a-z][a-z0-9-]+$", maxLength: 48 } }, required: ["id"], additionalProperties: false },
      outputSchema: { type: "object", properties: { theme: { type: "object" } }, required: ["theme"], additionalProperties: false },
      annotations: { title: "Read theme tokens", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      invoke(value) {
        const input = inputObject(value, ["id"]);
        if (typeof input.id !== "string" || input.id.length > 48 || !/^[a-z][a-z0-9-]+$/u.test(input.id)) throw new McpToolError("INVALID_INPUT", "id must be a canonical theme id.");
        const theme = CLANK_THEME_PRESETS.find((candidate) => candidate.id === input.id);
        if (!theme) throw new McpToolError("THEME_NOT_FOUND", "The requested theme does not exist.");
        return { theme: themeRecord(theme, true) };
      },
    },
  ],
});
const mcpManifest = designMcp.manifest();

function brandedAsset(request: Request, filename: string): Response | Promise<Response> {
  const url = new URL(request.url); url.pathname = `/brand/${filename}`; url.search = "";
  return appFiles.handle(new Request(url, { headers: request.headers }));
}

function versionedAsset(request: Request, filename: string): Response | Promise<Response> {
  const target = new Map([
    [`app.${manifest.assetVersion}.js`, "app.js"],
    [`styles.${manifest.assetVersion}.css`, "styles.css"],
    ["studio.js", "studio.js"],
    ["stories.js", "stories.js"],
  ]).get(filename);
  if (!target) return text("Asset not found.\n", { status: 404 });
  const url = new URL(request.url); url.pathname = `/${target}`; url.search = "";
  const response = appFiles.handle(new Request(url, { headers: request.headers }));
  if (!filename.endsWith(".js") || filename.startsWith("app.")) return response;
  return Promise.resolve(response).then((served) => {
    const headers = new Headers(served.headers);
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    return new Response(served.body, { status: served.status, headers });
  });
}

async function page(view: StudioView, path: string, status = 200): Promise<Response> {
  const entry = UI_COMPONENT_CATALOG.find((candidate) => candidate.slug === view);
  const title = view === "overview" ? "Clank Design Studio" : view === "themes" ? "Themes · Clank Design Studio" : entry ? `${entry.name} · Clank Design Studio` : "Not found · Clank Design Studio";
  const description = entry?.description ?? (view === "themes" ? "Compare ten dependency-free Clank themes across color, radius, density, typography, depth, focus, and motion." : "Explore all 37 Clank headless UI component families and ten live dependency-free themes.");
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const state = { initialView: view, initialTheme: "clank", frameworkVersion: manifest.frameworkVersion };
  const document = await renderDocument(<div id="design-root"><DesignStudio {...state} /></div>, {
    title,
    nonce,
    bodyClass: "design-body",
    stylesheets: [`/assets/styles.${manifest.assetVersion}.css`],
    state,
    head: <><meta name="description" content={description} /><meta name="theme-color" content="#0a0b0a" /><meta name="robots" content={status === 404 ? "noindex" : "index,follow"} /><link rel="icon" href={`/brand/favicon.ico?v=${manifest.assetVersion}`} sizes="any" /><link rel="icon" href={`/brand/clank-mark-32.png?v=${manifest.assetVersion}`} type="image/png" sizes="32x32" /><link rel="apple-touch-icon" href={`/brand/apple-touch-icon.png?v=${manifest.assetVersion}`} /><link rel="canonical" href={`${canonicalOrigin}${path}`} /><link rel="alternate" type="application/json" href="/api/catalog.json" title="Component catalog" /><meta property="og:title" content={title} /><meta property="og:description" content={description} /><meta property="og:type" content="website" /><meta property="og:url" content={`${canonicalOrigin}${path}`} /><script type="module" nonce={nonce} dangerouslySetInnerHTML={{ __html: `import(\"/assets/app.${manifest.assetVersion}.js\").catch((error) => console.error(\"Clank Design enhancement failed.\", error))` }} /></>,
  });
  return html(document, { status, headers: { "cache-control": "public, max-age=180, stale-while-revalidate=86400", "content-security-policy": ["default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "font-src 'self'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"].join("; ") } });
}

function llmsIndex(): string {
  return ["# Clank Design Studio", "", "> The canonical interactive catalog for Clank's dependency-free headless UI and theme system.", "", `Framework version: ${manifest.frameworkVersion}`, `Components: ${UI_COMPONENT_COUNT}`, `Themes: ${CLANK_THEME_PRESETS.length}`, "", "## Agent entry points", "", `- [Component catalog](${canonicalOrigin}/api/catalog.json)`, `- [Theme catalog](${canonicalOrigin}/api/themes.json)`, `- [MCP discovery](${canonicalOrigin}/.well-known/clank)`, `- MCP endpoint: ${canonicalOrigin}/__clank/mcp`, "", "## Package imports", "", "- `@clank.run/framework/ui` exports every controller.", "- `@clank.run/framework/ui/<slug>` exposes a focused family path.", "- `@clank.run/framework/ui/theme` exposes typed presets, custom theme validation, CSS generation, and DOM application.", ""].join("\n");
}

const app = createApp({ onError(error) { console.error("Design Studio request failed.", error instanceof Error ? error.message : "Unknown error"); } })
  .use(securityHeaders({ contentSecurityPolicy: false }))
  .get("/healthz", () => json({ ok: true, service: "clank-design", version: manifest.frameworkVersion, components: UI_COMPONENT_COUNT, themes: CLANK_THEME_PRESETS.length }, { headers: { "cache-control": "no-store" } }))
  .get("/.well-known/clank", () => json({ protocol: "clank-agent/2", contractRevision: designMcp.revision, name: "clank-design", title: "Clank Design Studio", description: "Discover the complete Clank UI and theme contract.", mcp: { transport: "streamable-http", protocolVersion: MCP_PROTOCOL_VERSION, serverVersion: mcpManifest.server.version, endpoint: `${canonicalOrigin}/__clank/mcp`, authentication: "none" }, documentation: { actions: "Call design.components, design.component, design.themes, or design.theme.", compact: `${canonicalOrigin}/llms.txt`, catalog: `${canonicalOrigin}/api/catalog.json` } }, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=0, must-revalidate", etag: `"${designMcp.revision}"`, "x-clank-contract-revision": designMcp.revision } }))
  .get("/.well-known/mcp/server-card.json", () => json({ "$schema": "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json", version: "1.0", protocolVersion: MCP_PROTOCOL_VERSION, contractRevision: designMcp.revision, serverInfo: { name: "clank-design", title: "Clank Design Studio", version: mcpManifest.server.version }, description: "Discover Clank's dependency-free UI families and design tokens.", documentationUrl: `${canonicalOrigin}/.well-known/clank`, transport: { type: "streamable-http", endpoint: "/__clank/mcp" }, capabilities: { tools: { listChanged: designMcp.supportsToolListChanged } }, authentication: { required: false, schemes: [] }, instructions: "Connect and call tools/list. Every tool is public and read-only.", tools: ["dynamic"] }, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=0, must-revalidate", etag: `"${designMcp.revision}"`, "x-clank-contract-revision": designMcp.revision } }))
  .route("*", "/__clank/mcp", ({ request }) => designMcp.handle(request))
  .route("HEAD", "/favicon.ico", ({ request }) => brandedAsset(request, "favicon.ico"))
  .get("/favicon.ico", ({ request }) => brandedAsset(request, "favicon.ico"))
  .route("HEAD", "/apple-touch-icon.png", ({ request }) => brandedAsset(request, "apple-touch-icon.png"))
  .get("/apple-touch-icon.png", ({ request }) => brandedAsset(request, "apple-touch-icon.png"))
  .get("/", () => page("overview", "/"))
  .get("/themes", () => page("themes", "/themes"))
  .get("/components/:slug", ({ params, url }) => {
    if (url.pathname.endsWith("/")) return new Response(null, { status: 308, headers: { location: url.pathname.slice(0, -1) } });
    const entry = UI_COMPONENT_CATALOG.find((candidate) => candidate.slug === params.slug);
    return entry ? page(entry.slug, `/components/${entry.slug}`) : page(params.slug, `/components/${encodeURIComponent(params.slug)}`, 404);
  })
  .get("/api/catalog.json", () => json({ protocol: manifest.protocol, frameworkVersion: manifest.frameworkVersion, total: UI_COMPONENT_COUNT, components: UI_COMPONENT_CATALOG.map(componentRecord) }, { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } }))
  .get("/api/components/:filename", ({ params }) => { const slug = params.filename.replace(/\.json$/u, ""); const entry = UI_COMPONENT_CATALOG.find((candidate) => candidate.slug === slug); return entry ? json({ protocol: "clank-component/1", frameworkVersion: manifest.frameworkVersion, component: componentRecord(entry) }, { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } }) : json({ error: { code: "COMPONENT_NOT_FOUND", message: "Component not found." } }, { status: 404 }); })
  .get("/api/themes.json", () => json({ protocol: "clank-theme-catalog/1", frameworkVersion: manifest.frameworkVersion, total: CLANK_THEME_PRESETS.length, themes: CLANK_THEME_PRESETS.map((theme) => themeRecord(theme, true)) }, { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } }))
  .get("/api/themes/:filename", ({ params }) => { const id = params.filename.replace(/\.json$/u, ""); const theme = CLANK_THEME_PRESETS.find((candidate) => candidate.id === id); return theme ? json({ frameworkVersion: manifest.frameworkVersion, theme: themeRecord(theme, true) }, { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } }) : json({ error: { code: "THEME_NOT_FOUND", message: "Theme not found." } }, { status: 404 }); })
  .get("/llms.txt", () => text(llmsIndex(), { headers: { "cache-control": "public, max-age=3600" } }))
  .get("/robots.txt", () => text(`User-agent: *\nAllow: /\nSitemap: ${canonicalOrigin}/sitemap.xml\n`))
  .get("/sitemap.xml", () => { const left = String.fromCharCode(60); const paths = ["/", "/themes", ...UI_COMPONENT_CATALOG.map((entry) => `/components/${entry.slug}`)]; return new Response(`${left}?xml version="1.0" encoding="UTF-8"?>${left}urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `${left}url>${left}loc>${canonicalOrigin}${path}${left}/loc>${left}/url>`).join("")}${left}/urlset>`, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } }); })
  .get("/assets/:filename", ({ request, params }) => versionedAsset(request, params.filename))
  .route("*", "/brand/*", ({ request }) => appFiles.handle(request))
  .get("/vendor/*", ({ request }) => vendorFiles.handle(request))
  .route("*", "*", ({ url }) => page("missing", url.pathname, 404));

const server = await serve(app, { hostname: environment?.HOST ?? "127.0.0.1", port: Number(environment?.PORT ?? 4400), trustProxy: environment?.TRUST_PROXY === "1", allowedHosts: environment?.ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean) });
console.log(`Clank Design Studio: ${server.url}`);
