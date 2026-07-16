import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "clank";
/* @clankImportSource clank */ import { AuthGate, authState, createApi, createApp, createAuthClient, html, openBackend, renderDocument, securityHeaders, serve, staticFiles } from "clank";
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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vc2VydmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsUUFBUTtBQUN4Ryw0QkFBNEIsR0FDNUIsU0FDRSxRQUFRLEVBQ1IsU0FBUyxFQUNULFNBQVMsRUFDVCxTQUFTLEVBQ1QsZ0JBQWdCLEVBQ2hCLElBQUksRUFDSixXQUFXLEVBQ1gsY0FBYyxFQUNkLGVBQWUsRUFDZixLQUFLLEVBQ0wsV0FBVyxRQUNOLFFBQVE7QUFDZixTQUFTLE9BQU8sUUFBUSxlQUFlO0FBQ3ZDLFNBQVMsYUFBYSxRQUFRLGFBQWE7QUFFM0MsTUFBTSxjQUFjLEFBQUMsV0FFbEIsT0FBTyxFQUFFO0FBQ1osTUFBTSxjQUFjLG1CQUFtQixJQUFJLElBQUksTUFBTSxZQUFZLEdBQUcsRUFBRSxRQUFRO0FBQzlFLE1BQU0sV0FBVyxtQkFBbUIsSUFBSSxJQUFJLGVBQWUsWUFBWSxHQUFHLEVBQUUsUUFBUTtBQUNwRixNQUFNLGVBQWUsYUFBYSxrQkFDN0IsYUFBYSxtQkFDYixtQkFBbUIsSUFBSSxJQUFJLHNCQUFzQixZQUFZLEdBQUcsRUFBRSxRQUFRO0FBQy9FLE1BQU0sVUFBVSxNQUFNLFlBQVksU0FBUztJQUFFLE1BQU07QUFBYTtBQUNoRSxNQUFNLE1BQU07QUFDWixNQUFNLFdBQVcsWUFBWTtBQUM3QixNQUFNLFlBQVksWUFBWSxVQUFVO0lBQUUsUUFBUTtJQUFTLGNBQWM7QUFBVztBQUVwRixNQUFNLE1BQU0sWUFDVCxHQUFHLENBQUMsZ0JBQWdCO0lBQUUsdUJBQXVCO0FBQU0sSUFDbkQsR0FBRyxDQUFDLFlBQVksSUFBTSxTQUFTLElBQUksQ0FBQztRQUFFLElBQUk7UUFBTSxRQUFRO0lBQVEsR0FBRztRQUNsRSxTQUFTO1lBQUUsaUJBQWlCO1FBQVc7SUFDekMsSUFDQyxHQUFHLENB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