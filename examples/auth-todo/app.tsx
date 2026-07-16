import {
  AuthGate,
  createClient,
  hydrate,
  onCleanup,
  readState,
  signal,
  type AuthState,
} from "/dist/index.js";
import type { backend, Profile, Todo } from "./backend.ts";
import { TodoWorkspace } from "./view.tsx";

interface PageState {
  auth: AuthState;
  profile: Profile | null;
  todos: Todo[];
  version: number;
}

const initial = readState<PageState>() ?? {
  auth: { user: null, session: null },
  profile: null,
  todos: [],
  version: 0,
};

const client = createClient<typeof backend>({
  initialAuth: initial.auth,
});
client.seed(client.api.todos.list, {}, initial.todos, initial.version);
client.seed(client.api.profile.get, {}, initial.profile, initial.version);

function LiveTodos() {
  const todos = client.live(client.api.todos.list);
  const profile = client.live(client.api.profile.get);
  const pending = signal(0);
  const error = signal("");
  onCleanup(() => {
    todos.dispose();
    profile.dispose();
  });

  async function mutate<Output>(operation: () => Promise<Output>): Promise<boolean> {
    pending.value++;
    error.value = "";
    try {
      await operation();
      return true;
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "The todo operation failed.";
      return false;
    } finally {
      pending.value--;
    }
  }

  return (
    <TodoWorkspace
      user={client.auth.user.value!}
      profileName={profile.data.value?.displayName ?? client.auth.user.value?.profile.name ?? client.auth.user.value?.email.split("@")[0] ?? ""}
      profileVersion={profile.data.value?._version ?? null}
      todos={todos.data.value ?? initial.todos}
      version={Math.max(todos.version.value, profile.version.value)}
      connected={!todos.loading.value && !profile.loading.value && !todos.error.value && !profile.error.value}
      pending={pending.value > 0}
      error={error.value || (todos.error.value || profile.error.value ? "Live updates disconnected. Reconnecting…" : "")}
      add={(title) => void mutate(() => client.mutate(client.api.todos.add, { title }))}
      setDone={(id, done, version) => mutate(() => client.mutate(client.api.todos.setDone, { id, done, version }))}
      rename={(id, title, version) => mutate(() => client.mutate(client.api.todos.rename, { id, title, version }))}
      remove={(id, version) => mutate(() => client.mutate(client.api.todos.remove, { id, version }))}
      clearCompleted={() => mutate(() => client.mutate(client.api.todos.clearCompleted))}
      updateProfile={(displayName, version) => mutate(() => client.mutate(client.api.profile.update, { displayName, version }))}
      logout={() => void client.auth.logout()}
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

hydrate(document.querySelector("#app")!, <App />);

Object.assign(globalThis, {
  clankAuthTodo: {
    client,
    auth: client.auth,
  },
});
