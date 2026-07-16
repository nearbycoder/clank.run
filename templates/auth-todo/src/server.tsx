/* @clankImportSource clank */
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
} from "clank";
import { backend } from "./backend.ts";
import { TodoView } from "./view.tsx";

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const root = decodeURIComponent(new URL("./", import.meta.url).pathname);
const frameworkRoot = decodeURIComponent(new URL("../node_modules/clank/dist/", import.meta.url).pathname);
const databasePath = environment?.CLANK_DATABASE_PATH
  ?? environment?.CLANK_DATABASE
  ?? environment?.PROACT_DATABASE_PATH
  ?? environment?.PROACT_DATABASE
  ?? "app.sqlite";
const runtime = await openBackend(backend, { path: databasePath });
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
      ? caller.query(api.todos.list)
      : { value: [], version: runtime.version };
    const authClient = createAuthClient({ initial: bootAuth, immediate: false });
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const page = await renderDocument(
      <AuthGate auth={authClient}>
        <TodoView
          user={bootAuth.user!}
          todos={initial.value}
          version={initial.version}
          connected={true}
          add={() => {}}
          setDone={() => {}}
          remove={() => {}}
          logout={() => {}}
        />
      </AuthGate>,
      {
        title: "__PROJECT_TITLE__",
        bodyClass: "m-0 bg-slate-50 antialiased",
        nonce,
        head: (
          <>
            <script
              type="importmap"
              nonce={nonce}
              dangerouslySetInnerHTML={{
                __html: JSON.stringify({ imports: { clank: "/_clank/index.js" } }),
              }}
            />
            <script nonce={nonce} src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" />
          </>
        ),
        state: { auth: bootAuth, todos: initial.value, version: initial.version },
        scripts: ["/app.js"],
      },
    );
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
  .get("/_clank/*", ({ request }) => frameworkFiles.handle(request))
  .route("*", "*", ({ request }) => runtime.handle(request));

const server = await serve(app, {
  hostname: environment?.HOST ?? "127.0.0.1",
  port: Number(environment?.PORT ?? 3000),
  trustProxy: environment?.TRUST_PROXY === "1",
  allowedHosts: environment?.ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
});

console.log(`__PROJECT_TITLE__: ${server.url}`);
