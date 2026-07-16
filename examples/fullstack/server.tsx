/* @clankImportSource clank.run */
import {
  createApi,
  createApp,
  html,
  openBackend,
  renderDocument,
  serve,
  staticFiles,
} from "clank.run";
import { backend } from "./backend.ts";
import { TodoApp } from "./view.tsx";

const api = createApi<typeof backend>();
const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const exampleRoot = decodeURIComponent(new URL("./", import.meta.url).pathname);
const distRoot = decodeURIComponent(new URL("../../dist/", import.meta.url).pathname);
const databasePath = environment?.CLANK_DATABASE
  ?? decodeURIComponent(new URL("./fullstack.sqlite", import.meta.url).pathname);
const runtime = await openBackend(backend, { path: databasePath });

if (runtime.query(api.todos.list).value.length === 0) {
  runtime.mutation(api.todos.add, { title: "Open this page in two tabs" });
  const id = runtime.mutation(api.todos.add, { title: "Watch SQLite changes stream live" }).value;
  const todo = runtime.query(api.todos.list).value.find((entry) => entry._id === id)!;
  runtime.mutation(api.todos.toggle, { id, version: todo._version });
}

const examples = staticFiles(exampleRoot);
const framework = staticFiles(distRoot, { prefix: "/dist", cacheControl: "no-cache" });
const app = createApp()
  .get("/", async () => {
    const initial = runtime.query(api.todos.list);
    const page = await renderDocument(
      <TodoApp
        todos={initial.value}
        version={initial.version}
        connected={false}
        pending={false}
        add={() => {}}
        toggle={() => {}}
        remove={() => {}}
        clearCompleted={() => {}}
      />,
      {
        title: "Clank Full-Stack Todo",
        bodyClass: "m-0 bg-slate-50 antialiased",
        head: (
          <>
            <script type="importmap" dangerouslySetInnerHTML={{ __html: JSON.stringify({ imports: { clank: "/dist/index.js" } }) }} />
            <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
            <style type="text/tailwindcss" dangerouslySetInnerHTML={{ __html: "button,input{outline:none}" }} />
          </>
        ),
        state: { todos: initial.value, version: initial.version },
        scripts: ["/app.js"],
      },
    );
    return html(page, { headers: { "cache-control": "no-store" } });
  })
  .get("/app.js", ({ request }) => examples.handle(request))
  .get("/view.js", ({ request }) => examples.handle(request))
  .get("/dist/*", ({ request }) => framework.handle(request))
  .route("*", "*", ({ request }) => runtime.handle(request));

const server = await serve(app, {
  hostname: environment?.HOST ?? "127.0.0.1",
  port: Number(environment?.PORT ?? 4180),
});
console.log(`Clank full-stack example: ${server.url}`);
