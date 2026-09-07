/* @clankImportSource @clank.run/framework */
import {
  AuthGate,
  authState,
  createApi,
  createApp,
  createAuthClient,
  html,
  openBackend,
  renderDocument,
  securityHeaders,
  serve,
  staticFiles,
} from "@clank.run/framework";
import { backend } from "./backend.ts";
import { RecipeView } from "./view.tsx";

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const projectTitle = __PROJECT_TITLE_JSON__;
const root = decodeURIComponent(new URL("./", import.meta.url).pathname);
const frameworkRoot = decodeURIComponent(new URL("../node_modules/@clank.run/framework/dist/", import.meta.url).pathname);
const databasePath = environment?.CLANK_DATABASE_PATH
  ?? environment?.CLANK_DATABASE
  ?? environment?.PROACT_DATABASE_PATH
  ?? environment?.PROACT_DATABASE
  ?? "app.sqlite";
const runtime = await openBackend(backend, {
  path: databasePath,
  agent: {
    name: "booking",
    title: "Booking",
    description: "Reserve one 30-minute consultation. Start times use UTC.",
  },
});
const api = createApi<typeof backend>();
const appFiles = staticFiles(root);
const frameworkFiles = staticFiles(frameworkRoot, { prefix: "/_clank", cacheControl: "public, max-age=31536000, immutable" });

const app = createApp()
  .use(securityHeaders({ contentSecurityPolicy: false }))
  .get("/healthz", () => new Response("ok", { headers: { "cache-control": "no-store" } }))
  .get("/", async ({ request }) => {
    const caller = await runtime.caller(request);
    if (!caller.auth) throw new Error("Auth runtime is unavailable.");
    const bootAuth = authState(caller.auth);
    const initial = caller.auth.user
      ? caller.query(api.records.list)
      : { value: [], version: runtime.version };
    const authClient = createAuthClient({ initial: bootAuth, immediate: false });
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const page = await renderDocument(
      <AuthGate auth={authClient}>
        <RecipeView
          user={bootAuth.user!}
          records={initial.value}
          create={async () => false}
          update={async () => false}
          logout={() => {}}
        />
      </AuthGate>,
      {
        title: projectTitle,
        bodyClass: "recipe",
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
            <link rel="stylesheet" href="/styles.css" />
          </>
        ),
        state: { auth: bootAuth, records: initial.value, version: initial.version },
        scripts: ["/app.js"],
      },
    );
    return html(page, {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}'`,
          "style-src 'self'",
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
  .get("/styles.css", ({ request }) => appFiles.handle(request))
  .get("/_clank/*", ({ request }) => frameworkFiles.handle(request))
  .route("*", "*", ({ request }) => runtime.handle(request));

const server = await serve(app, {
  hostname: environment?.HOST ?? "127.0.0.1",
  port: Number(environment?.PORT ?? 3000),
  trustProxy: environment?.TRUST_PROXY === "1",
  allowedHosts: environment?.ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
});

console.log(`${projectTitle}: ${server.url}`);
