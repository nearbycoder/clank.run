import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "clank";
/* @clankImportSource clank */ import { createApi, createApp, html, openBackend, renderDocument, serve, staticFiles } from "clank";
import { backend } from "./backend.js";
import { TodoApp } from "./view.js";
const api = createApi();
const environment = globalThis.process?.env;
const exampleRoot = decodeURIComponent(new URL("./", import.meta.url).pathname);
const distRoot = decodeURIComponent(new URL("../../dist/", import.meta.url).pathname);
const databasePath = environment?.CLANK_DATABASE ?? decodeURIComponent(new URL("./fullstack.sqlite", import.meta.url).pathname);
const runtime = await openBackend(backend, {
    path: databasePath
});
if (runtime.query(api.todos.list).value.length === 0) {
    runtime.mutation(api.todos.add, {
        title: "Open this page in two tabs"
    });
    const id = runtime.mutation(api.todos.add, {
        title: "Watch SQLite changes stream live"
    }).value;
    const todo = runtime.query(api.todos.list).value.find((entry)=>entry._id === id);
    runtime.mutation(api.todos.toggle, {
        id,
        version: todo._version
    });
}
const examples = staticFiles(exampleRoot);
const framework = staticFiles(distRoot, {
    prefix: "/dist",
    cacheControl: "no-cache"
});
const app = createApp().get("/", async ()=>{
    const initial = runtime.query(api.todos.list);
    const page = await renderDocument(__clankJSX(TodoApp, {
        "todos": __clankExpression(()=>initial.value),
        "version": __clankExpression(()=>initial.version),
        "connected": false,
        "pending": false,
        "add": ()=>{},
        "toggle": ()=>{},
        "remove": ()=>{},
        "clearCompleted": ()=>{}
    }), {
        title: "Clank Full-Stack Todo",
        bodyClass: "m-0 bg-slate-50 antialiased",
        head: __clankJSX(__clankFragment, {}, __clankJSX("script", {
            "type": "importmap",
            "dangerouslySetInnerHTML": {
                __html: JSON.stringify({
                    imports: {
                        clank: "/dist/index.js"
                    }
                })
            }
        }), __clankJSX("script", {
            "src": "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"
        }), __clankJSX("style", {
            "type": "text/tailwindcss",
            "dangerouslySetInnerHTML": {
                __html: "button,input{outline:none}"
            }
        })),
        state: {
            todos: initial.value,
            version: initial.version
        },
        scripts: [
            "/app.js"
        ]
    });
    return html(page, {
        headers: {
            "cache-control": "no-store"
        }
    });
}).get("/app.js", ({ request })=>examples.handle(request)).get("/view.js", ({ request })=>examples.handle(request)).get("/dist/*", ({ request })=>framework.handle(request)).route("*", "*", ({ request })=>runtime.handle(request));
const server = await serve(app, {
    hostname: environment?.HOST ?? "127.0.0.1",
    port: Number(environment?.PORT ?? 4180)
});
console.log(`Clank full-stack example: ${server.url}`);


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9mdWxsc3RhY2svc2VydmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsUUFBUTtBQUN4Ryw0QkFBNEIsR0FDNUIsU0FDRSxTQUFTLEVBQ1QsU0FBUyxFQUNULElBQUksRUFDSixXQUFXLEVBQ1gsY0FBYyxFQUNkLEtBQUssRUFDTCxXQUFXLFFBQ04sUUFBUTtBQUNmLFNBQVMsT0FBTyxRQUFRLGVBQWU7QUFDdkMsU0FBUyxPQUFPLFFBQVEsYUFBYTtBQUVyQyxNQUFNLE1BQU07QUFDWixNQUFNLGNBQWMsQUFBQyxXQUFxRixPQUFPLEVBQUU7QUFDbkgsTUFBTSxjQUFjLG1CQUFtQixJQUFJLElBQUksTUFBTSxZQUFZLEdBQUcsRUFBRSxRQUFRO0FBQzlFLE1BQU0sV0FBVyxtQkFBbUIsSUFBSSxJQUFJLGVBQWUsWUFBWSxHQUFHLEVBQUUsUUFBUTtBQUNwRixNQUFNLGVBQWUsYUFBYSxrQkFDN0IsbUJBQW1CLElBQUksSUFBSSxzQkFBc0IsWUFBWSxHQUFHLEVBQUUsUUFBUTtBQUMvRSxNQUFNLFVBQVUsTUFBTSxZQUFZLFNBQVM7SUFBRSxNQUFNO0FBQWE7QUFFaEUsSUFBSSxRQUFRLEtBQUssQ0FBQyxJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLE1BQU0sS0FBSyxHQUFHO0lBQ3BELFFBQVEsUUFBUSxDQUFDLElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRTtRQUFFLE9BQU87SUFBNkI7SUFDdEUsTUFBTSxLQUFLLFFBQVEsUUFBUSxDQUFDLElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRTtRQUFFLE9BQU87SUFBbUMsR0FBRyxLQUFLO0lBQy9GLE1BQU0sT0FBTyxRQUFRLEtBQUssQ0FBQyxJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVUsTUFBTSxHQUFHLEtBQUs7SUFDL0UsUUFBUSxRQUFRLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxFQUFFO1FBQUU7UUFBSSxTQUFTLEtBQUssUUFBUTtJQUFDO0FBQ2xFO0FBRUEsTUFBTSxXQUFXLFlBQVk7QUFDN0IsTUFBTSxZQUFZLFlBQVksVUFBVTtJQUFFLFFBQVE7SUFBUyxjQUFjO0FBQVc7QUFDcEYsTUFBTSxNQUFNLFlBQ1QsR0FBRyxDQUFDLEtBQUs7SUFDUixNQUFNLFVBQVUsUUFBUSxLQUFLLENBQUMsSUFBSSxLQUFLLENBQUMsSUFBSTtJQUM1QyxNQUFNLE9BQU8sTUFBTSxlQUNqQixXQUFXLFNBQVM7UUFBRSxTQUFTLGtCQUFrQixJQUFPLFFBQVEsS0FBSztRQUFJLFdBQVcsa0JBQWtCLElBQU8sUUFBUSxPQUFPO1FBQUksYUFBYTtRQUFPLFdBQVc7UUFBTyxPQUFPLEtBQU87UUFBRyxVQUFVLEtBQU87UUFBRyxVQUFVLEtBQU87UUFBRyxrQkFBa0IsS0FBTztJQUFFLElBQzFQO1FBQ0UsT0FBTztRQUNQLFdBQVc7UUFDWCxNQUNFLFdBQVcsaUJBQWlCLENBQUcsR0FBRyxXQUFXLFVBQVU7WUFBRSxRQUFRO1lBQWEsMkJBQTJCO2dCQUFFLFFBQVEsS0FBSyxTQUFTLENBQUM7b0JBQUUsU0FBUzt3QkFBRSxPQUFPO29CQUFpQjtnQkFBRTtZQUFHO1FBQUUsSUFBSSxXQUFXLFVBQVU7WUFBRSxPQUFPO1FBQXNELElBQUksV0FBVyxTQUFTO1lBQUUsUUFBUTtZQUFvQiwyQkFBMkI7Z0JBQUUsUUFBUTtZQUE2QjtRQUFFO1FBRWxZLE9BQU87WUFBRSxPQUFPLFFBQVEsS0FBSztZQUFFLFNBQVMsUUFBUSxPQUFPO1FBQUM7UUFDeEQsU0FBUztZQUFDO1NBQVU7SUFDdEI7SUFFRixPQUFPLEtBQUssTUFBTTtRQUFFLFNBQVM7WUFBRSxpQkFBaUI7UUFBVztJQUFFO0FBQy9ELEdBQ0MsR0FBRyxDQUFDLFdBQVcsQ0FBQyxFQUFFLE9BQU8sRUFBRSxHQUFLLFNBQVMsTUFBTSxDQUFDLFVBQ2hELEdBQUcsQ0FBQyxZQUFZLENBQUMsRUFBRSxPQUFPLEVBQUUsR0FBSyxTQUFTLE1BQU0sQ0FBQyxVQUNqRCxHQUFHLENBQUMsV0FBVyxDQUFDLEVBQUUsT0FBTyxFQUFFLEdBQUssVUFBVSxNQUFNLENBQUMsVUFDakQsS0FBSyxDQUFDLEtBQUssS0FBSyxDQUFDLEVBQUUsT0FBTyxFQUFFLEdBQUssUUFBUSxNQUFNLENBQUM7QUFFbkQsTUFBTSxTQUFTLE1BQU0sTUFBTSxLQUFLO0lBQzlCLFVBQVUsYUFBYSxRQUFRO0lBQy9CLE1BQU0sT0FBTyxhQUFhLFFBQVE7QUFDcEM7QUFDQSxRQUFRLEdBQUcsQ0FBQyxDQUFDLDBCQUEwQixFQUFFLE9BQU8sR0FBRyxFQUFFIn0=