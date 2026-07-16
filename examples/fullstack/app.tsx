import {
  createApi,
  createSyncClient,
  hydrate,
  readState,
  signal,
} from "/dist/index.js";
import type { backend, Todo } from "./backend.ts";
import { TodoApp } from "./view.tsx";

const api = createApi<typeof backend>();
const initial = readState<{ todos: Todo[]; version: number }>() ?? { todos: [], version: 0 };
const client = createSyncClient();
client.seed(api.todos.list, {}, initial.todos, initial.version);
const todos = client.live(api.todos.list);
const pending = signal(false);

async function mutate<Output>(operation: () => Promise<Output>): Promise<Output | undefined> {
  pending.value = true;
  try { return await operation(); }
  finally { pending.value = false; }
}

function App() {
  return (
    <TodoApp
      todos={todos.data.value ?? initial.todos}
      version={todos.version.value}
      connected={!todos.loading.value && !todos.error.value}
      pending={pending.value}
      add={(title) => void mutate(() => client.mutate(api.todos.add, { title }))}
      toggle={(id, version) => void mutate(() => client.mutate(api.todos.toggle, { id, version }))}
      remove={(id, version) => void mutate(() => client.mutate(api.todos.remove, { id, version }))}
      clearCompleted={() => void mutate(() => client.mutate(api.todos.clearCompleted))}
    />
  );
}

const root = document.querySelector("#app")!;
const serverRoot = root.firstElementChild;
const serverRows = [...root.querySelectorAll("li")];
hydrate(root, <App />);
Object.assign(globalThis, {
  clankFullstack: {
    api,
    client,
    todos,
    hydration: {
      rootPreserved: root.firstElementChild === serverRoot,
      rowsPreserved: serverRows.every((row, index) => root.querySelectorAll("li")[index] === row),
    },
  },
});
