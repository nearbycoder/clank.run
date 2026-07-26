import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "@clank.run/framework";
/* @clankImportSource @clank.run/framework */ import { createApi, createApp, html, openBackend, renderDocument, serve, staticFiles } from "@clank.run/framework";
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
                        "@clank.run/framework": "/dist/index.js"
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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9mdWxsc3RhY2svc2VydmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsdUJBQXVCO0FBQ3ZILDJDQUEyQyxHQUMzQyxTQUNFLFNBQVMsRUFDVCxTQUFTLEVBQ1QsSUFBSSxFQUNKLFdBQVcsRUFDWCxjQUFjLEVBQ2QsS0FBSyxFQUNMLFdBQVcsUUFDTix1QkFBdUI7QUFDOUIsU0FBUyxPQUFPLFFBQVEsZUFBZTtBQUN2QyxTQUFTLE9BQU8sUUFBUSxhQUFhO0FBRXJDLE1BQU0sTUFBTTtBQUNaLE1BQU0sY0FBYyxBQUFDLFdBQXFGLE9BQU8sRUFBRTtBQUNuSCxNQUFNLGNBQWMsbUJBQW1CLElBQUksSUFBSSxNQUFNLFlBQVksR0FBRyxFQUFFLFFBQVE7QUFDOUUsTUFBTSxXQUFXLG1CQUFtQixJQUFJLElBQUksZUFBZSxZQUFZLEdBQUcsRUFBRSxRQUFRO0FBQ3BGLE1BQU0sZUFBZSxhQUFhLGtCQUM3QixtQkFBbUIsSUFBSSxJQUFJLHNCQUFzQixZQUFZLEdBQUcsRUFBRSxRQUFRO0FBQy9FLE1BQU0sVUFBVSxNQUFNLFlBQVksU0FBUztJQUFFLE1BQU07QUFBYTtBQUVoRSxJQUFJLFFBQVEsS0FBSyxDQUFDLElBQUksS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsTUFBTSxLQUFLLEdBQUc7SUFDcEQsUUFBUSxRQUFRLENBQUMsSUFBSSxLQUFLLENBQUMsR0FBRyxFQUFFO1FBQUUsT0FBTztJQUE2QjtJQUN0RSxNQUFNLEtBQUssUUFBUSxRQUFRLENBQUMsSUFBSSxLQUFLLENBQUMsR0FBRyxFQUFFO1FBQUUsT0FBTztJQUFtQyxHQUFHLEtBQUs7SUFDL0YsTUFBTSxPQUFPLFFBQVEsS0FBSyxDQUFDLElBQUksS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBVSxNQUFNLEdBQUcsS0FBSztJQUMvRSxRQUFRLFFBQVEsQ0FBQyxJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUU7UUFBRTtRQUFJLFNBQVMsS0FBSyxRQUFRO0lBQUM7QUFDbEU7QUFFQSxNQUFNLFdBQVcsWUFBWTtBQUM3QixNQUFNLFlBQVksWUFBWSxVQUFVO0lBQUUsUUFBUTtJQUFTLGNBQWM7QUFBVztBQUNwRixNQUFNLE1BQU0sWUFDVCxHQUFHLENBQUMsS0FBSztJQUNSLE1BQU0sVUFBVSxRQUFRLEtBQUssQ0FBQyxJQUFJLEtBQUssQ0FBQyxJQUFJO0lBQzVDLE1BQU0sT0FBTyxNQUFNLGVBQ2pCLFdBQVcsU0FBUztRQUFFLFNBQVMsa0JBQWtCLElBQU8sUUFBUSxLQUFLO1FBQUksV0FBVyxrQkFBa0IsSUFBTyxRQUFRLE9BQU87UUFBSSxhQUFhO1FBQU8sV0FBVztRQUFPLE9BQU8sS0FBTztRQUFHLFVBQVUsS0FBTztRQUFHLFVBQVUsS0FBTztRQUFHLGtCQUFrQixLQUFPO0lBQUUsSUFDMVA7UUFDRSxPQUFPO1FBQ1AsV0FBVztRQUNYLE1BQ0UsV0FBVyxpQkFBaUIsQ0FBRyxHQUFHLFdBQVcsVUFBVTtZQUFFLFFBQVE7WUFBYSwyQkFBMkI7Z0JBQUUsUUFBUSxLQUFLLFNBQVMsQ0FBQztvQkFBRSxTQUFTO3dCQUFFLHdCQUF3QjtvQkFBaUI7Z0JBQUU7WUFBRztRQUFFLElBQUksV0FBVyxVQUFVO1lBQUUsT0FBTztRQUFzRCxJQUFJLFdBQVcsU0FBUztZQUFFLFFBQVE7WUFBb0IsMkJBQTJCO2dCQUFFLFFBQVE7WUFBNkI7UUFBRTtRQUVuWixPQUFPO1lBQUUsT0FBTyxRQUFRLEtBQUs7WUFBRSxTQUFTLFFBQVEsT0FBTztRQUFDO1FBQ3hELFNBQVM7WUFBQztTQUFVO0lBQ3RCO0lBRUYsT0FBTyxLQUFLLE1BQU07UUFBRSxTQUFTO1lBQUUsaUJBQWlCO1FBQVc7SUFBRTtBQUMvRCxHQUNDLEdBQUcsQ0FBQyxXQUFXLENBQUMsRUFBRSxPQUFPLEVBQUUsR0FBSyxTQUFTLE1BQU0sQ0FBQyxVQUNoRCxHQUFHLENBQUMsWUFBWSxDQUFDLEVBQUUsT0FBTyxFQUFFLEdBQUssU0FBUyxNQUFNLENBQUMsVUFDakQsR0FBRyxDQUFDLFdBQVcsQ0FBQyxFQUFFLE9BQU8sRUFBRSxHQUFLLFVBQVUsTUFBTSxDQUFDLFVBQ2pELEtBQUssQ0FBQyxLQUFLLEtBQUssQ0FBQyxFQUFFLE9BQU8sRUFBRSxHQUFLLFFBQVEsTUFBTSxDQUFDO0FBRW5ELE1BQU0sU0FBUyxNQUFNLE1BQU0sS0FBSztJQUM5QixVQUFVLGFBQWEsUUFBUTtJQUMvQixNQUFNLE9BQU8sYUFBYSxRQUFRO0FBQ3BDO0FBQ0EsUUFBUSxHQUFHLENBQUMsQ0FBQywwQkFBMEIsRUFBRSxPQUFPLEdBQUcsRUFBRSJ9