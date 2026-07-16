import { computed, For, render, signal } from "/dist/index.js";

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

const draft = signal("");
const todos = signal<Todo[]>([
  { id: crypto.randomUUID(), title: "Try Clank TSX", done: true },
  { id: crypto.randomUUID(), title: "Ship a fine-grained app", done: false },
]);
const remaining = computed(() => todos.value.filter((todo) => !todo.done).length);

function addTodo(event: SubmitEvent) {
  event.preventDefault();
  const title = draft.peek().trim();
  if (!title) return;
  todos.update((items) => [...items, { id: crypto.randomUUID(), title, done: false }]);
  draft.value = "";
}

function toggleTodo(id: string) {
  todos.update((items) => items.map((todo) =>
    todo.id === id ? { ...todo, done: !todo.done } : todo
  ));
}

function removeTodo(id: string) {
  todos.update((items) => items.filter((todo) => todo.id !== id));
}

function App() {
  return (
    <main class="mx-auto min-h-screen max-w-2xl px-5 py-16 text-slate-900">
      <header class="mb-8">
        <p class="mb-2 text-xs font-bold uppercase tracking-[.24em] text-orange-500">Clank example</p>
        <h1 class="text-5xl font-semibold tracking-tight">Things to do</h1>
        <p class="mt-3 text-slate-500">TSX ergonomics with direct, keyed DOM updates.</p>
      </header>

      <section class="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60">
        <form class="flex gap-3 border-b border-slate-100 p-5" onSubmit={addTodo}>
          <input
            class="min-w-0 flex-1 rounded-full bg-slate-100 px-5 py-3 outline-none ring-orange-400 focus:ring-2"
            placeholder="What needs doing?"
            bind:value={draft}
            agentId="todo-title"
            agentLabel="New todo title"
          />
          <button
            class="rounded-full bg-slate-900 px-6 py-3 font-semibold text-white hover:bg-orange-500"
            type="submit"
            agentId="add-todo"
            agentLabel="Add todo"
          >
            Add
          </button>
        </form>

        <ul class="divide-y divide-slate-100">
          <For each={todos.value} by="id" fallback={<li class="p-8 text-center text-slate-400">All clear.</li>}>
            {(todo) => (
              <li class="flex items-center gap-4 p-5" agentId={`todo-${todo.id}`} agentLabel={todo.title}>
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-full border border-slate-300 text-sm"
                  classList={{ "border-emerald-500 bg-emerald-500 text-white": todo.done }}
                  onClick={() => toggleTodo(todo.id)}
                  agentLabel={`Toggle ${todo.title}`}
                >
                  {todo.done ? "✓" : ""}
                </button>
                <span class={todo.done ? "flex-1 text-slate-400 line-through" : "flex-1"}>{todo.title}</span>
                <button
                  class="rounded-full px-3 py-1 text-sm text-slate-400 hover:bg-red-50 hover:text-red-600"
                  onClick={() => removeTodo(todo.id)}
                  agentLabel={`Remove ${todo.title}`}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>

        <footer class="flex items-center justify-between bg-slate-50 px-5 py-4 text-sm text-slate-500">
          <span>{remaining.value} remaining</span>
          <button
            class="font-medium hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={remaining.value === todos.value.length}
            onClick={() => todos.update((items) => items.filter((todo) => !todo.done))}
          >
            Clear completed
          </button>
        </footer>
      </section>
    </main>
  );
}

render(document.querySelector("#app")!, <App />);
