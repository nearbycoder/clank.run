import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "@clank.run/framework";
import { AuthGate, authState, createApi, createApp, createAuthClient, html, openBackend, renderDocument, securityHeaders, serve, staticFiles } from "@clank.run/framework";
import { backend } from "./backend.js";
import { TodoWorkspace } from "./view.js";
const environment = globalThis.process?.env;
const exampleRoot = decodeURIComponent(new URL("./", import.meta.url).pathname);
const distRoot = decodeURIComponent(new URL("../../dist/", import.meta.url).pathname);
const databasePath = environment?.CLANK_DATABASE ?? environment?.PROACT_DATABASE ?? decodeURIComponent(new URL("./auth-todo.sqlite", import.meta.url).pathname);
const runtime = await openBackend(backend, {
    path: databasePath,
    agent: {
        name: "clank-private-todo",
        title: "Clank Private Todo",
        description: "Manage private todos through authenticated, documented MCP actions."
    }
});
const api = createApi();
const examples = staticFiles(exampleRoot);
const framework = staticFiles(distRoot, {
    prefix: "/dist",
    cacheControl: "no-cache"
});
const app = createApp().use(securityHeaders({
    contentSecurityPolicy: false
})).get("/healthz", ()=>Response.json({
        ok: true,
        status: "ready"
    }, {
        headers: {
            "cache-control": "no-store"
        }
    })).get("/", async ({ request })=>{
    const caller = await runtime.caller(request);
    if (!caller.auth) throw new Error("The authenticated backend did not create auth state.");
    const bootAuth = authState(caller.auth);
    const initial = caller.auth.user ? caller.query(api.todos.list) : {
        value: [],
        version: runtime.version
    };
    const initialProfile = caller.auth.user ? caller.query(api.profile.get) : {
        value: null,
        version: runtime.version
    };
    const authClient = createAuthClient({
        initial: bootAuth,
        immediate: false
    });
    const nonce = globalThis.crypto.randomUUID().replaceAll("-", "");
    const page = await renderDocument(__clankJSX(AuthGate, {
        "auth": __clankExpression(()=>authClient)
    }, __clankJSX(TodoWorkspace, {
        "user": __clankExpression(()=>bootAuth.user),
        "profileName": __clankExpression(()=>initialProfile.value?.displayName ?? bootAuth.user?.profile.name ?? bootAuth.user?.email.split("@")[0] ?? ""),
        "profileVersion": __clankExpression(()=>initialProfile.value?._version ?? null),
        "todos": __clankExpression(()=>initial.value),
        "version": __clankExpression(()=>Math.max(initial.version, initialProfile.version)),
        "connected": true,
        "pending": false,
        "add": ()=>{},
        "setDone": ()=>{},
        "rename": ()=>Promise.resolve(false),
        "remove": ()=>{},
        "clearCompleted": ()=>{},
        "updateProfile": ()=>Promise.resolve(false),
        "logout": ()=>{}
    })), {
        title: "Clank Private Todo",
        bodyClass: "m-0 bg-slate-50 antialiased",
        nonce,
        head: __clankJSX(__clankFragment, {}, __clankJSX("script", {
            "type": "importmap",
            "nonce": __clankExpression(()=>nonce),
            "dangerouslySetInnerHTML": {
                __html: JSON.stringify({
                    imports: {
                        "@clank.run/framework": "/dist/index.js"
                    }
                })
            }
        }), __clankJSX("script", {
            "nonce": __clankExpression(()=>nonce),
            "src": "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"
        })),
        state: {
            auth: bootAuth,
            todos: initial.value,
            profile: initialProfile.value,
            version: Math.max(initial.version, initialProfile.version)
        },
        scripts: [
            "/app.js"
        ]
    });
    const contentSecurityPolicy = [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'"
    ].join("; ");
    return html(page, {
        headers: {
            "cache-control": "no-store",
            "content-security-policy": contentSecurityPolicy
        }
    });
}).get("/app.js", ({ request })=>examples.handle(request)).get("/view.js", ({ request })=>examples.handle(request)).get("/dist/*", ({ request })=>framework.handle(request)).route("*", "*", ({ request })=>runtime.handle(request));
const allowedHosts = environment?.ALLOWED_HOSTS?.split(",").map((host)=>host.trim()).filter(Boolean);
const server = await serve(app, {
    hostname: environment?.HOST ?? "127.0.0.1",
    port: Number(environment?.PORT ?? 4181),
    trustProxy: environment?.TRUST_PROXY === "1",
    ...allowedHosts?.length ? {
        allowedHosts
    } : {}
});
console.log(`Clank authenticated Todo: ${server.url}`);


//# sourceURL=/home/nearby/Sites/clank/examples/auth-todo/server.tsx