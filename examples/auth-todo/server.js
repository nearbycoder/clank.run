import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "clank.run";
/* @clankImportSource clank.run */ import { AuthGate, authState, createApi, createApp, createAuthClient, html, openBackend, renderDocument, securityHeaders, serve, staticFiles } from "clank.run";
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
                        clank: "/dist/index.js"
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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vc2VydmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsWUFBWTtBQUM1RyxnQ0FBZ0MsR0FDaEMsU0FDRSxRQUFRLEVBQ1IsU0FBUyxFQUNULFNBQVMsRUFDVCxTQUFTLEVBQ1QsZ0JBQWdCLEVBQ2hCLElBQUksRUFDSixXQUFXLEVBQ1gsY0FBYyxFQUNkLGVBQWUsRUFDZixLQUFLLEVBQ0wsV0FBVyxRQUNOLFlBQVk7QUFDbkIsU0FBUyxPQUFPLFFBQVEsZUFBZTtBQUN2QyxTQUFTLGFBQWEsUUFBUSxhQUFhO0FBRTNDLE1BQU0sY0FBYyxBQUFDLFdBRWxCLE9BQU8sRUFBRTtBQUNaLE1BQU0sY0FBYyxtQkFBbUIsSUFBSSxJQUFJLE1BQU0sWUFBWSxHQUFHLEVBQUUsUUFBUTtBQUM5RSxNQUFNLFdBQVcsbUJBQW1CLElBQUksSUFBSSxlQUFlLFlBQVksR0FBRyxFQUFFLFFBQVE7QUFDcEYsTUFBTSxlQUFlLGFBQWEsa0JBQzdCLGFBQWEsbUJBQ2IsbUJBQW1CLElBQUksSUFBSSxzQkFBc0IsWUFBWSxHQUFHLEVBQUUsUUFBUTtBQUMvRSxNQUFNLFVBQVUsTUFBTSxZQUFZLFNBQVM7SUFBRSxNQUFNO0FBQWE7QUFDaEUsTUFBTSxNQUFNO0FBQ1osTUFBTSxXQUFXLFlBQVk7QUFDN0IsTUFBTSxZQUFZLFlBQVksVUFBVTtJQUFFLFFBQVE7SUFBUyxjQUFjO0FBQVc7QUFFcEYsTUFBTSxNQUFNLFlBQ1QsR0FBRyxDQUFDLGdCQUFnQjtJQUFFLHVCQUF1QjtBQUFNLElBQ25ELEdBQUcsQ0FBQyxZQUFZLElBQU0sU0FBUyxJQUFJLENBQUM7UUFBRSxJQUFJO1FBQU0sUUFBUTtJQUFRLEdBQUc7UUFDbEUsU0FBUztZQUFFLGlCQUFpQjtRQUFXO0lBQ3pDLElBQ0MsR0FBRyxD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