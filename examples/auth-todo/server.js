import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "@clank.run/framework";
/* @clankImportSource @clank.run/framework */ import { AuthGate, authState, createApi, createApp, createAuthClient, html, openBackend, renderDocument, securityHeaders, serve, staticFiles } from "@clank.run/framework";
import { backend } from "./backend.js";
import { TodoWorkspace } from "./view.js";
const environment = globalThis.process?.env;
const exampleRoot = decodeURIComponent(new URL("./", import.meta.url).pathname);
const distRoot = decodeURIComponent(new URL("../../dist/", import.meta.url).pathname);
const databasePath = environment?.CLANK_DATABASE ?? environment?.PROACT_DATABASE ?? decodeURIComponent(new URL("./auth-todo.sqlite", import.meta.url).pathname);
const runtime = await openBackend(backend, {
    path: databasePath
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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vc2VydmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsdUJBQXVCO0FBQ3ZILDJDQUEyQyxHQUMzQyxTQUNFLFFBQVEsRUFDUixTQUFTLEVBQ1QsU0FBUyxFQUNULFNBQVMsRUFDVCxnQkFBZ0IsRUFDaEIsSUFBSSxFQUNKLFdBQVcsRUFDWCxjQUFjLEVBQ2QsZUFBZSxFQUNmLEtBQUssRUFDTCxXQUFXLFFBQ04sdUJBQXVCO0FBQzlCLFNBQVMsT0FBTyxRQUFRLGVBQWU7QUFDdkMsU0FBUyxhQUFhLFFBQVEsYUFBYTtBQUUzQyxNQUFNLGNBQWMsQUFBQyxXQUVsQixPQUFPLEVBQUU7QUFDWixNQUFNLGNBQWMsbUJBQW1CLElBQUksSUFBSSxNQUFNLFlBQVksR0FBRyxFQUFFLFFBQVE7QUFDOUUsTUFBTSxXQUFXLG1CQUFtQixJQUFJLElBQUksZUFBZSxZQUFZLEdBQUcsRUFBRSxRQUFRO0FBQ3BGLE1BQU0sZUFBZSxhQUFhLGtCQUM3QixhQUFhLG1CQUNiLG1CQUFtQixJQUFJLElBQUksc0JBQXNCLFlBQVksR0FBRyxFQUFFLFFBQVE7QUFDL0UsTUFBTSxVQUFVLE1BQU0sWUFBWSxTQUFTO0lBQUUsTUFBTTtBQUFhO0FBQ2hFLE1BQU0sTUFBTTtBQUNaLE1BQU0sV0FBVyxZQUFZO0FBQzdCLE1BQU0sWUFBWSxZQUFZLFVBQVU7SUFBRSxRQUFRO0lBQVMsY0FBYztBQUFXO0FBRXBGLE1BQU0sTUFBTSxZQUNULEdBQUcsQ0FBQyxnQkFBZ0I7SUFBRSx1QkFBdUI7QUFBTSxJQUNuRCxHQUFHLENBQUMsWUFBWSxJQUFNLFNBQVMsSUFBSSxDQUFDO1FBQUUsSUFBSTtRQUFNLFFBQVE7SUFBUSxHQUFHO1FBQ2xFLFNBQVM7WUFBRSxpQkFBaUI7UUFBVztJQUN6QyxJQUNDLEdB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