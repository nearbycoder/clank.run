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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vYXBwLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsaUJBQWlCO0FBQ2pILFNBQ0UsUUFBUSxFQUNSLFlBQVksRUFDWixPQUFPLEVBQ1AsU0FBUyxFQUNULFNBQVMsRUFDVCxNQUFNLFFBRUQsaUJBQWlCO0FBRXhCLFNBQVMsYUFBYSxRQUFRLGFBQWE7QUFTM0MsTUFBTSxVQUFVLGVBQTBCO0lBQ3hDLE1BQU07UUFBRSxNQUFNO1FBQU0sU0FBUztJQUFLO0lBQ2xDLFNBQVM7SUFDVCxPQUFPLEVBQUU7SUFDVCxTQUFTO0FBQ1g7QUFFQSxNQUFNLFNBQVMsYUFBNkI7SUFDMUMsYUFBYSxRQUFRLElBQUk7QUFDM0I7QUFDQSxPQUFPLElBQUksQ0FBQyxPQUFPLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsR0FBRyxRQUFRLEtBQUssRUFBRSxRQUFRLE9BQU87QUFDckUsT0FBTyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsUUFBUSxPQUFPLEVBQUUsUUFBUSxPQUFPO0FBRXhFLFNBQVM7SUFDUCxNQUFNLFFBQVEsT0FBTyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUk7SUFDL0MsTUFBTSxVQUFVLE9BQU8sSUFBSSxDQUFDLE9BQU8sR0FBRyxDQUFDLE9BQU8sQ0FBQyxHQUFHO0lBQ2xELE1BQU0sVUFBVSxPQUFPO0lBQ3ZCLE1BQU0sUUFBUSxPQUFPO0lBQ3JCLFVBQVU7UUFDUixNQUFNLE9BQU87UUFDYixRQUFRLE9BQU87SUFDakI7SUFFQSxlQUFlLE9BQWUsU0FBZ0M7UUFDNUQsUUFBUSxLQUFLO1FBQ2IsTUFBTSxLQUFLLEdBQUc7UUFDZCxJQUFJO1lBQ0YsTUFBTTtZQUNO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