/* @clankImportSource clank.run */
import { For, signal, type Id } from "clank.run";
import type { Todo } from "./backend.ts";

export function TodoApp(props: {
  todos: Todo[];
  version: number;
  connected: boolean;
  pending: boolean;
  add(title: string): unknown;
  toggle(id: Id<"todos">, version: number): unknown;
  remove(id: Id<"todos">, version: number): unknown;
  clearCompleted(): unknown;
}) {
  const draft = signal("");
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const title = draft.peek().trim();
    if (!title) return;
    props.add(title);
    draft.value = "";
  };

  return (
    <main class="mx-auto min-h-screen max-w-3xl px-5 py-14 text-slate-950 sm:py-20">
      <header class="mb-9 flex flex-wrap items-end justify-between gap-5">
        <div>
          <div class="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[.24em] text-orange-600">
            <span class="size-2 rounded-full bg-orange-500" /> Clank full stack
          </div>
          <h1 class="text-5xl font-semibold tracking-[-.05em] sm:text-7xl">Live work.</h1>
          <p class="mt-4 max-w-xl text-slate-500">Server-rendered TSX, inferred RPC, transactional SQLite, and live query updates.</p>
        </div>
        <div class="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold shadow-sm">
          <span class={props.connected ? "text-emerald-600" : "text-amber-600"}>{props.connected ? "● synced" : "○ connecting"}</span>
          <span class="sr-only">database snapshot {props.version}</span>
        </div>
      </header>

      <section class="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-2xl shadow-slate-200/70">
        <form class="flex gap-3 border-b border-slate-100 p-5 sm:p-6" onSubmit={submit}>
          <input
            class="min-w-0 flex-1 rounded-full bg-slate-100 px-5 py-3 outline-none ring-orange-400 transition focus:ring-2"
            placeholder="Add something useful…"
            bind:value={draft}
            disabled={props.pending}
            agentId="live-todo-title"
            agentLabel="New live todo title"
          />
          <button
            class="rounded-full bg-slate-950 px-6 py-3 font-semibold text-white transition hover:bg-orange-500 disabled:opacity-50"
            type="submit"
            disabled={props.pending}
            agentId="add-live-todo"
            agentLabel="Add live todo"
          >
            Add
          </button>
        </form>

        <ul class="divide-y divide-slate-100">
          <For each={props.todos} by="_id" fallback={<li class="p-10 text-center text-slate-400">The shared list is clear.</li>}>
            {(todo) => (
              <li class="flex items-center gap-4 p-5 sm:px-6" agentId={`live-todo-${todo._id}`} agentLabel={todo.title}>
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-full border border-slate-300 text-sm"
                  classList={{ "border-emerald-500 bg-emerald-500 text-white": todo.done }}
                  onClick={() => props.toggle(todo._id, todo._version)}
                  agentLabel={`Toggle ${todo.title}`}
                >
                  {todo.done ? "✓" : ""}
                </button>
                <span class={todo.done ? "min-w-0 flex-1 text-slate-400 line-through" : "min-w-0 flex-1"}>{todo.title}</span>
                <button
                  class="rounded-full px-3 py-1 text-sm text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                  onClick={() => props.remove(todo._id, todo._version)}
                  agentLabel={`Remove ${todo.title}`}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>

        <footer class="flex items-center justify-between gap-4 bg-slate-50 px-5 py-4 text-sm text-slate-500 sm:px-6">
          <span>{props.todos.filter((todo) => !todo.done).length} open · {props.todos.length} synced</span>
          <button
            class="font-semibold text-slate-500 hover:text-slate-950 disabled:opacity-40"
            disabled={props.pending || !props.todos.some((todo) => todo.done)}
            onClick={() => props.clearCompleted()}
          >
            Clear completed
          </button>
        </footer>
      </section>

      <p class="mt-6 text-center text-xs text-slate-400">Open this URL in another tab. Mutations committed there stream here automatically.</p>
    </main>
  );
}
