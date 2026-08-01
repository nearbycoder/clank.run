/* @clankImportSource ../vendor/dom.js */
import {
  createApp,
  html,
  json,
  renderDocument,
  securityHeaders,
  serve,
  staticFiles,
  text,
} from "../vendor/index.js";
import { SynthView } from "./view.js";

const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const canonicalOrigin = (environment?.SYNTH_ORIGIN ?? "https://synth.clank.run").replace(/\/+$/u, "");
const distRoot = decodeURIComponent(new URL("./", import.meta.url).pathname);
const vendorRoot = decodeURIComponent(new URL("../vendor/", import.meta.url).pathname);
const appFiles = staticFiles(distRoot, { cacheControl: "public, max-age=31536000, immutable" });
const vendorFiles = staticFiles(vendorRoot, { prefix: "/vendor", cacheControl: "public, max-age=31536000, immutable" });

function asset(request: Request): Response | Promise<Response> {
  const source = new URL(request.url);
  source.pathname = source.pathname.replace(/^\/assets/u, "") || "/";
  return appFiles.handle(new Request(source, { method: request.method, headers: request.headers }));
}

async function page(): Promise<Response> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const document = await renderDocument(<div id="synth-root"><SynthView frameworkVersion="0.14.0" /></div>, {
    title: "Clank Synth · Audio Lab",
    nonce,
    bodyClass: "synth-body",
    stylesheets: ["/assets/styles.css"],
    state: { frameworkVersion: "0.14.0" },
    head: <>
      <meta name="description" content="A playable 16-step Web Audio groovebox built with Clank." />
      <meta name="theme-color" content="#080a0d" />
      <link rel="icon" href="/brand/favicon.ico" sizes="any" />
      <link rel="icon" href="/brand/clank-mark-32.png" type="image/png" sizes="32x32" />
      <link rel="canonical" href={canonicalOrigin} />
      <script type="module" nonce={nonce} dangerouslySetInnerHTML={{ __html: `import("/assets/app.js").catch((error) => console.error("Clank Synth enhancement failed.", error))` }} />
    </>,
  });
  return html(document, {
    headers: {
      "cache-control": "no-store",
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

const app = createApp({ onError(error) { console.error("Clank Synth request failed.", error instanceof Error ? error.message : "Unknown error"); } })
  .use(securityHeaders({ contentSecurityPolicy: false }))
  .get("/healthz", () => json({ ok: true, service: "clank-synth", frameworkVersion: "0.14.0", instruments: 6, steps: 16 }, { headers: { "cache-control": "no-store" } }))
  .get("/.well-known/clank", () => json({ protocol: "clank-agent/2", name: "clank-synth", title: "Clank Synth", description: "A playable 16-step audio groovebox.", documentation: { home: canonicalOrigin, source: "https://github.com/nearbycoder/clank.run/tree/main/synth-site" }, capabilities: { browserAudio: true, persistence: "localStorage" } }, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" } }))
  .get("/api/info", () => json({ protocol: "clank-synth/1", frameworkVersion: "0.14.0", instruments: 6, steps: 16, presets: ["Neon Pulse", "Night Drive", "Arcade Bloom", "Half Time"] }, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" } }))
  .route("HEAD", "/favicon.ico", ({ request }) => asset(new Request(new URL("/brand/favicon.ico", request.url), { headers: request.headers })))
  .get("/favicon.ico", ({ request }) => asset(new Request(new URL("/brand/favicon.ico", request.url), { headers: request.headers })))
  .route("*", "/brand/*", ({ request }) => appFiles.handle(request))
  .get("/assets/*", ({ request }) => asset(request))
  .get("/vendor/*", ({ request }) => vendorFiles.handle(request))
  .get("/", page)
  .get("/llms.txt", () => text(`# Clank Synth\n\nA playable 16-step Web Audio groovebox built with Clank.\n\n- Home: ${canonicalOrigin}\n- Metadata: ${canonicalOrigin}/api/info\n- Framework: @clank.run/framework 0.14.0\n- Six voices: kick, snare, hi-hat, clap, bass, lead\n- Patterns remain in browser localStorage.\n`, { headers: { "cache-control": "public, max-age=3600" } }))
  .route("*", "*", page);

const server = await serve(app, {
  hostname: environment?.HOST ?? "127.0.0.1",
  port: Number(environment?.PORT ?? 4600),
  trustProxy: environment?.TRUST_PROXY === "1",
  allowedHosts: environment?.ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
});

console.log(`Clank Synth: ${server.url}`);
