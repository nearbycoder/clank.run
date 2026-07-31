import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "/dist/index.js";
import { AuthGate, createClient, hydrate, onCleanup, readState, signal } from "/dist/index.js";
import { TodoWorkspace } from "./view.js";
const initial = readState() ?? {
    auth: {
        user: null,
        session: null
    },
    profile: null,
    todos: [],
    version: 0
};
const client = createClient({
    initialAuth: initial.auth
});
client.seed(client.api.todos.list, {}, initial.todos, initial.version);
client.seed(client.api.profile.get, {}, initial.profile, initial.version);
function LiveTodos() {
    const todos = client.live(client.api.todos.list);
    const profile = client.live(client.api.profile.get);
    const pending = signal(0);
    const error = signal("");
    onCleanup(()=>{
        todos.dispose();
        profile.dispose();
    });
    async function mutate(operation) {
        pending.value++;
        error.value = "";
        try {
            await operation();
            return true;
        } catch (reason) {
            error.value = reason instanceof Error ? reason.message : "The todo operation failed.";
            return false;
        } finally{
            pending.value--;
        }
    }
    return __clankJSX(TodoWorkspace, {
        "user": __clankExpression(()=>client.auth.user.value),
        "profileName": __clankExpression(()=>profile.data.value?.displayName ?? client.auth.user.value?.profile.name ?? client.auth.user.value?.email.split("@")[0] ?? ""),
        "profileVersion": __clankExpression(()=>profile.data.value?._version ?? null),
        "todos": __clankExpression(()=>todos.data.value ?? initial.todos),
        "version": __clankExpression(()=>Math.max(todos.version.value, profile.version.value)),
        "connected": __clankExpression(()=>!todos.loading.value && !profile.loading.value && !todos.error.value && !profile.error.value),
        "pending": __clankExpression(()=>pending.value > 0),
        "error": __clankExpression(()=>error.value || (todos.error.value || profile.error.value ? "Live updates disconnected. Reconnecting…" : "")),
        "add": (title)=>void mutate(()=>client.mutate(client.api.todos.add, {
                    title
                })),
        "setDone": (id, done, version)=>mutate(()=>client.mutate(client.api.todos.setDone, {
                    id,
                    done,
                    version
                })),
        "rename": (id, title, version)=>mutate(()=>client.mutate(client.api.todos.rename, {
                    id,
                    title,
                    version
                })),
        "remove": (id, version)=>mutate(()=>client.mutate(client.api.todos.remove, {
                    id,
                    version
                })),
        "clearCompleted": ()=>mutate(()=>client.mutate(client.api.todos.clearCompleted)),
        "updateProfile": (displayName, version)=>mutate(()=>client.mutate(client.api.profile.update, {
                    displayName,
                    version
                })),
        "logout": ()=>void client.auth.logout()
    });
}
function App() {
    return __clankJSX(AuthGate, {
        "auth": __clankExpression(()=>client.auth)
    }, __clankJSX(LiveTodos, {}));
}
hydrate(document.querySelector("#app"), __clankJSX(App, {}));
Object.assign(globalThis, {
    clankAuthTodo: {
        client,
        auth: client.auth
    }
});


//# sourceURL=/home/nearby/Sites/clank/examples/auth-todo/app.tsx