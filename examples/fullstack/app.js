import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "/dist/index.js";
import { createApi, createSyncClient, hydrate, readState, signal } from "/dist/index.js";
import { TodoApp } from "./view.js";
const api = createApi();
const initial = readState() ?? {
    todos: [],
    version: 0
};
const client = createSyncClient();
client.seed(api.todos.list, {}, initial.todos, initial.version);
const todos = client.live(api.todos.list);
const pending = signal(false);
async function mutate(operation) {
    pending.value = true;
    try {
        return await operation();
    } finally{
        pending.value = false;
    }
}
function App() {
    return __clankJSX(TodoApp, {
        "todos": __clankExpression(()=>todos.data.value ?? initial.todos),
        "version": __clankExpression(()=>todos.version.value),
        "connected": __clankExpression(()=>!todos.loading.value && !todos.error.value),
        "pending": __clankExpression(()=>pending.value),
        "add": (title)=>void mutate(()=>client.mutate(api.todos.add, {
                    title
                })),
        "toggle": (id, version)=>void mutate(()=>client.mutate(api.todos.toggle, {
                    id,
                    version
                })),
        "remove": (id, version)=>void mutate(()=>client.mutate(api.todos.remove, {
                    id,
                    version
                })),
        "clearCompleted": ()=>void mutate(()=>client.mutate(api.todos.clearCompleted))
    });
}
const root = document.querySelector("#app");
const serverRoot = root.firstElementChild;
const serverRows = [
    ...root.querySelectorAll("li")
];
hydrate(root, __clankJSX(App, {}));
Object.assign(globalThis, {
    clankFullstack: {
        api,
        client,
        todos,
        hydration: {
            rootPreserved: root.firstElementChild === serverRoot,
            rowsPreserved: serverRows.every((row, index)=>root.querySelectorAll("li")[index] === row)
        }
    }
});


//# sourceURL=/home/nearby/Sites/clank/examples/fullstack/app.tsx