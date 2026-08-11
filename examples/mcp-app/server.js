import { createApp, createMcpAppDocument, createMcpServer, defineMcpApp, serve } from "@clank.run/framework";
const environment = globalThis.process?.env;
const statusView = defineMcpApp({
    uri: "ui://clank-example/status",
    name: "clank_status",
    title: "Clank service status",
    description: "A dependency-free status card rendered inside an MCP host.",
    prefersBorder: true,
    html: createMcpAppDocument({
        title: "Clank status",
        body: `<main><span class="eyebrow">MCP APP</span><h1 id="status">Loading…</h1><dl><div><dt>Runtime</dt><dd id="runtime">—</dd></div><div><dt>Revision</dt><dd id="revision">—</dd></div></dl><button id="refresh">Refresh</button></main>`,
        styles: `:root{color-scheme:light dark;font-family:var(--font-sans,system-ui)}body{margin:0;background:transparent;color:var(--color-text-primary,CanvasText)}main{display:grid;gap:14px;padding:18px}.eyebrow{color:var(--color-text-success,#15803d);font-size:11px;font-weight:700;letter-spacing:.14em}h1{margin:0;font-size:var(--font-heading-lg-size,24px)}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}dl div{padding:10px;border:1px solid var(--color-border-secondary,#8885);border-radius:var(--border-radius-md,8px)}dt{font-size:12px;color:var(--color-text-secondary,#666)}dd{margin:4px 0 0;font-weight:600}button{justify-self:start;padding:8px 12px;border:0;border-radius:var(--border-radius-md,8px);background:var(--color-background-inverse,#111);color:var(--color-text-inverse,#fff)}`,
        script: `const api=globalThis.ClankMcpApp;const render=(result)=>{const value=result?.structuredContent??result?.value??result;document.querySelector("#status").textContent=value?.ok?"All systems operational":"Unavailable";document.querySelector("#runtime").textContent=value?.runtime??"unknown";document.querySelector("#revision").textContent=String(value?.revision??"unknown")};const client=api.createMcpAppClient({name:"clank-status-view",onHostContext:api.applyMcpAppTheme,onToolResult:render});document.querySelector("#refresh").addEventListener("click",async()=>render(await client.callTool("system_status",{})));client.connect().then(async()=>render(await client.callTool("system_status",{})));`
    })
});
const startedAt = Date.now();
const mcp = createMcpServer({
    name: "clank-mcp-app-example",
    title: "Clank MCP App Example",
    description: "Public read-only MCP Apps conformance example.",
    browserCors: true,
    apps: [
        statusView
    ],
    tools: [
        {
            name: "system.status",
            title: "System status",
            description: "Read the example server's current status.",
            inputSchema: {
                type: "object",
                additionalProperties: false
            },
            outputSchema: {
                type: "object",
                properties: {
                    ok: {
                        type: "boolean"
                    },
                    runtime: {
                        type: "string"
                    },
                    revision: {
                        type: "integer"
                    }
                },
                required: [
                    "ok",
                    "runtime",
                    "revision"
                ],
                additionalProperties: false
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            app: {
                resourceUri: statusView.uri,
                visibility: [
                    "model",
                    "app"
                ]
            },
            invoke: ()=>({
                    ok: true,
                    runtime: "Clank dependency-free MCP Apps",
                    revision: Math.floor((Date.now() - startedAt) / 1_000)
                })
        }
    ]
});
const app = createApp().get("/", ()=>new Response("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Clank MCP App</title><style>body{margin:0;background:#0a0a0a;color:#f5f5f5;font:16px system-ui}main{max-width:720px;margin:12vh auto;padding:24px}span{color:#83f28f;font-size:12px;font-weight:700;letter-spacing:.14em}h1{font-size:clamp(38px,8vw,72px);letter-spacing:-.05em;margin:12px 0}code{display:block;padding:16px;border:1px solid #333;border-radius:10px;overflow-wrap:anywhere}</style></head><body><main><span>MCP APPS · READY</span><h1>Interactive tools, no dependencies.</h1><p>Connect an MCP Apps host to:</p><code>/mcp</code></main></body></html>", {
        headers: {
            "content-type": "text/html; charset=utf-8"
        }
    })).get("/healthz", ()=>Response.json({
        ok: true
    })).route("*", "/mcp", ({ request })=>mcp.handle(request));
const server = await serve(app, {
    hostname: environment?.HOST ?? "127.0.0.1",
    port: Number(environment?.PORT ?? 4182)
});
console.log(`Clank MCP App example: ${server.url}/mcp`);


//# sourceURL=/home/nearby/Sites/clank/examples/mcp-app/server.ts