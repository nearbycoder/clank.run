/* @clankImportSource @clank.run/framework */
import {
  createApp,
  html,
  renderDocument,
  securityHeaders,
  serve,
  staticFiles,
} from "@clank.run/framework";
import { StarterView } from "./view.tsx";

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const root = decodeURIComponent(new URL("./", import.meta.url).pathname);
const frameworkRoot = decodeURIComponent(new URL("../node_modules/@clank.run/framework/dist/", import.meta.url).pathname);
const appFiles = staticFiles(root);
const frameworkFiles = staticFiles(frameworkRoot, {
  prefix: "/_clank",
  cacheControl: "public, max-age=31536000, immutable",
});

const app = createApp()
  .use(securityHeaders({ contentSecurityPolicy: false }))
  .get("/healthz", () => new Response("ok", { headers: { "cache-control": "no-store" } }))
  .get("/", async () => {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const page = await renderDocument(<StarterView />, {
      title: "__PROJECT_TITLE__",
      bodyClass: "m-0 bg-slate-50 antialiased",
      nonce,
      head: (
        <>
          <script
            type="importmap"
            nonce={nonce}
            dangerouslySetInnerHTML={{
              __html: JSON.stringify({ imports: { "@clank.run/framework": "/_clank/index.js" } }),
            }}
          />
          <script nonce={nonce} src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" />
        </>
      ),
      scripts: ["/app.js"],
    });
    return html(page, {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self'",
          "img-src 'self' data:",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          "object-src 'none'",
        ].join("; "),
      },
    });
  })
  .get("/app.js", ({ request }) => appFiles.handle(request))
  .get("/view.js", ({ request }) => appFiles.handle(request))
  .get("/_clank/*", ({ request }) => frameworkFiles.handle(request));

const server = await serve(app, {
  hostname: environment?.HOST ?? "127.0.0.1",
  port: Number(environment?.PORT ?? 3000),
  trustProxy: environment?.TRUST_PROXY === "1",
  allowedHosts: environment?.ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
});

console.log(`__PROJECT_TITLE__: ${server.url}`);
