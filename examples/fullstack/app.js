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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9mdWxsc3RhY2svYXBwLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsaUJBQWlCO0FBQ2pILFNBQ0UsU0FBUyxFQUNULGdCQUFnQixFQUNoQixPQUFPLEVBQ1AsU0FBUyxFQUNULE1BQU0sUUFDRCxpQkFBaUI7QUFFeEIsU0FBUyxPQUFPLFFBQVEsYUFBYTtBQUVyQyxNQUFNLE1BQU07QUFDWixNQUFNLFVBQVUsZUFBbUQ7SUFBRSxPQUFPLEVBQUU7SUFBRSxTQUFTO0FBQUU7QUFDM0YsTUFBTSxTQUFTO0FBQ2YsT0FBTyxJQUFJLENBQUMsSUFBSSxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsR0FBRyxRQUFRLEtBQUssRUFBRSxRQUFRLE9BQU87QUFDOUQsTUFBTSxRQUFRLE9BQU8sSUFBSSxDQUFDLElBQUksS0FBSyxDQUFDLElBQUk7QUFDeEMsTUFBTSxVQUFVLE9BQU87QUFFdkIsZUFBZSxPQUFlLFNBQWdDO0lBQzVELFFBQVEsS0FBSyxHQUFHO0lBQ2hCLElBQUk7UUFBRSxPQUFPLE1BQU07SUFBYSxTQUN4QjtRQUFFLFFBQVEsS0FBSyxHQUFHO0lBQU87QUFDbkM7QUFFQSxTQUFTO0lBQ1AsT0FDRSxXQUFXLFNBQVM7UUFBRSxTQUFTLGtCQUFrQixJQUFPLE1BQU0sSUFBSSxDQUFDLEtBQUssSUFBSSxRQUFRLEtBQUs7UUFBSSxXQUFXLGtCQUFrQixJQUFPLE1BQU0sT0FBTyxDQUFDLEtBQUs7UUFBSSxhQUFhLGtCQUFrQixJQUFPLENBQUMsTUFBTSxPQUFPLENBQUMsS0FBSyxJQUFJLENBQUMsTUFBTSxLQUFLLENBQUMsS0FBSztRQUFJLFdBQVcsa0JBQWtCLElBQU8sUUFBUSxLQUFLO1FBQUksT0FBTyxDQUFDLFFBQVUsS0FBSyxPQUFPLElBQU0sT0FBTyxNQUFNLENBQUMsSUFBSSxLQUFLLENBQUMsR0FBRyxFQUFFO29CQUFFO2dCQUFNO1FBQUssVUFBVSxDQUFDLElBQUksVUFBWSxLQUFLLE9BQU8sSUFBTSxPQUFPLE1BQU0sQ0FBQyxJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUU7b0JBQUU7b0JBQUk7Z0JBQVE7UUFBSyxVQUFVLENBQUMsSUFBSSxVQUFZLEtBQUssT0FBTyxJQUFNLE9BQU8sTUFBTSxDQUFDLElBQUksS0FBSyxDQUFDLE1BQU0sRUFBRTtvQkFBRTtvQkFBSTtnQkFBUTtRQUFLLGtCQUFrQixJQUFNLEtBQUssT0FBTyxJQUFNLE9BQU8sTUFBTSxDQUFDLElBQUksS0FBSyxDQUFDLGNBQWM7SUFBRztBQUV0b0I7QUFFQSxNQUFNLE9BQU8sU0FBUyxhQUFhLENBQUM7QUFDcEMsTUFBTSxhQUFhLEtBQUssaUJBQWlCO0FBQ3pDLE1BQU0sYUFBYTtPQUFJLEtBQUssZ0JBQWdCLENBQUM7Q0FBTTtBQUNuRCxRQUFRLE1BQU0sV0FBVyxLQUFLLENBQUc7QUFDakMsT0FBTyxNQUFNLENBQUMsWUFBWTtJQUN4QixnQkFBZ0I7UUFDZDtRQUNBO1FBQ0E7UUFDQSxXQUFXO1lBQ1QsZUFBZSxLQUFLLGlCQUFpQixLQUFLO1lBQzFDLGVBQWUsV0FBVyxLQUFLLENBQUMsQ0FBQyxLQUFLLFFBQVUsS0FBSyxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsTUFBTSxLQUFLO1FBQ3pGO0lBQ0Y7QUFDRiJ9