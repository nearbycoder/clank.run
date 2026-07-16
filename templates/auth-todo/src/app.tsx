/* @clankImportSource clank.run */
import {
  AuthGate,
  createClient,
  hydrate,
  onCleanup,
  readState,
  signal,
  type AuthState,
  type DefaultAuthProfile,
} from "clank.run";
import type { backend, Todo } from "./backend.ts";
import { TodoView } from "./view.tsx";

interface PageState {
  auth: AuthState<DefaultAuthProfile>;
  todos: Todo[];
  version: number;
}

const boot = readState<PageState>() ?? {
  auth: { user: null, session: null },
  todos: [],
  version: 0,
};
const client = createClient<typeof backend>({ initialAuth: boot.auth });
client.seed(client.api.todos.list, {}, boot.todos, boot.version);

function LiveTodos() {
  const todos = client.live(client.api.todos.list);
  const error = signal("");
  onCleanup(() => todos.dispose());
  const mutate = async (operation: () => Promise<unknown>) => {
    error.value = "";
    try {
      await operation();
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "The operation failed.";
    }
  };
  return (
    <TodoView
      user={client.auth.user.value!}
      todos={todos.data.value ?? boot.todos}
      version={todos.version.value}
      connected={!todos.loading.value && !todos.error.value}
      add={(title) => mutate(() => client.mutate(client.api.todos.add, { title }))}
      setDone={(id, done, version) => mutate(() => client.mutate(client.api.todos.setDone, { id, done, version }))}
      remove={(id, version) => mutate(() => client.mutate(client.api.todos.remove, { id, version }))}
      logout={() => client.auth.logout()}
    />
  );
}

function App() {
  return (
    <AuthGate auth={client.auth}>
      <LiveTodos />
    </AuthGate>
  );
}

hydrate(document.getElementById("app")!, <App />);
