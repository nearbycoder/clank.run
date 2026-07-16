import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "clank.run";
/* @clankImportSource clank.run */ import { createApi, createApp, html, openBackend, renderDocument, serve, staticFiles } from "clank.run";
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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9mdWxsc3RhY2svc2VydmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsWUFBWTtBQUM1RyxnQ0FBZ0MsR0FDaEMsU0FDRSxTQUFTLEVBQ1QsU0FBUyxFQUNULElBQUksRUFDSixXQUFXLEVBQ1gsY0FBYyxFQUNkLEtBQUssRUFDTCxXQUFXLFFBQ04sWUFBWTtBQUNuQixTQUFTLE9BQU8sUUFBUSxlQUFlO0FBQ3ZDLFNBQVMsT0FBTyxRQUFRLGFBQWE7QUFFckMsTUFBTSxNQUFNO0FBQ1osTUFBTSxjQUFjLEFBQUMsV0FBcUYsT0FBTyxFQUFFO0FBQ25ILE1BQU0sY0FBYyxtQkFBbUIsSUFBSSxJQUFJLE1BQU0sWUFBWSxHQUFHLEVBQUUsUUFBUTtBQUM5RSxNQUFNLFdBQVcsbUJBQW1CLElBQUksSUFBSSxlQUFlLFlBQVksR0FBRyxFQUFFLFFBQVE7QUFDcEYsTUFBTSxlQUFlLGFBQWEsa0JBQzdCLG1CQUFtQixJQUFJLElBQUksc0JBQXNCLFlBQVksR0FBRyxFQUFFLFFBQVE7QUFDL0UsTUFBTSxVQUFVLE1BQU0sWUFBWSxTQUFTO0lBQUUsTUFBTTtBQUFhO0FBRWhFLElBQUksUUFBUSxLQUFLLENBQUMsSUFBSSxLQUFLLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxNQUFNLEtBQUssR0FBRztJQUNwRCxRQUFRLFFBQVEsQ0FBQyxJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUU7UUFBRSxPQUFPO0lBQTZCO0lBQ3RFLE1BQU0sS0FBSyxRQUFRLFFBQVEsQ0FBQyxJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUU7UUFBRSxPQUFPO0lBQW1DLEdBQUcsS0FBSztJQUMvRixNQUFNLE9BQU8sUUFBUSxLQUFLLENBQUMsSUFBSSxLQUFLLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxRQUFVLE1BQU0sR0FBRyxLQUFLO0lBQy9FLFFBQVEsUUFBUSxDQUFDLElBQUksS0FBSyxDQUFDLE1BQU0sRUFBRTtRQUFFO1FBQUksU0FBUyxLQUFLLFFBQVE7SUFBQztBQUNsRTtBQUVBLE1BQU0sV0FBVyxZQUFZO0FBQzdCLE1BQU0sWUFBWSxZQUFZLFVBQVU7SUFBRSxRQUFRO0lBQVMsY0FBYztBQUFXO0FBQ3BGLE1BQU0sTUFBTSxZQUNULEdBQUcsQ0FBQyxLQUFLO0lBQ1IsTUFBTSxVQUFVLFFBQVEsS0FBSyxDQUFDLElBQUksS0FBSyxDQUFDLElBQUk7SUFDNUMsTUFBTSxPQUFPLE1BQU0sZUFDakIsV0FBVyxTQUFTO1FBQUUsU0FBUyxrQkFBa0IsSUFBTyxRQUFRLEtBQUs7UUFBSSxXQUFXLGtCQUFrQixJQUFPLFFBQVEsT0FBTztRQUFJLGFBQWE7UUFBTyxXQUFXO1FBQU8sT0FBTyxLQUFPO1FBQUcsVUFBVSxLQUFPO1FBQUcsVUFBVSxLQUFPO1FBQUcsa0JBQWtCLEtBQU87SUFBRSxJQUMxUDtRQUNFLE9BQU87UUFDUCxXQUFXO1FBQ1gsTUFDRSxXQUFXLGlCQUFpQixDQUFHLEdBQUcsV0FBVyxVQUFVO1lBQUUsUUFBUTtZQUFhLDJCQUEyQjtnQkFBRSxRQUFRLEtBQUssU0FBUyxDQUFDO29CQUFFLFNBQVM7d0JBQUUsT0FBTztvQkFBaUI7Z0JBQUU7WUFBRztRQUFFLElBQUksV0FBVyxVQUFVO1lBQUUsT0FBTztRQUFzRCxJQUFJLFdBQVcsU0FBUztZQUFFLFFBQVE7WUFBb0IsMkJBQTJCO2dCQUFFLFFBQVE7WUFBNkI7UUFBRTtRQUVsWSxPQUFPO1lBQUUsT0FBTyxRQUFRLEtBQUs7WUFBRSxTQUFTLFFBQVEsT0FBTztRQUFDO1FBQ3hELFNBQVM7WUFBQztTQUFVO0lBQ3RCO0lBRUYsT0FBTyxLQUFLLE1BQU07UUFBRSxTQUFTO1lBQUUsaUJBQWlCO1FBQVc7SUFBRTtBQUMvRCxHQUNDLEdBQUcsQ0FBQyxXQUFXLENBQUMsRUFBRSxPQUFPLEVBQUUsR0FBSyxTQUFTLE1BQU0sQ0FBQyxVQUNoRCxHQUFHLENBQUMsWUFBWSxDQUFDLEVBQUUsT0FBTyxFQUFFLEdBQUssU0FBUyxNQUFNLENBQUMsVUFDakQsR0FBRyxDQUFDLFdBQVcsQ0FBQyxFQUFFLE9BQU8sRUFBRSxHQUFLLFVBQVUsTUFBTSxDQUFDLFVBQ2pELEtBQUssQ0FBQyxLQUFLLEtBQUssQ0FBQyxFQUFFLE9BQU8sRUFBRSxHQUFLLFFBQVEsTUFBTSxDQUFDO0FBRW5ELE1BQU0sU0FBUyxNQUFNLE1BQU0sS0FBSztJQUM5QixVQUFVLGFBQWEsUUFBUTtJQUMvQixNQUFNLE9BQU8sYUFBYSxRQUFRO0FBQ3BDO0FBQ0EsUUFBUSxHQUFHLENBQUMsQ0FBQywwQkFBMEIsRUFBRSxPQUFPLEdBQUcsRUFBRSJ9