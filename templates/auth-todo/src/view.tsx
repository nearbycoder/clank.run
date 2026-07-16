/* @clankImportSource clank */
import { For, signal, type AuthUser, type DefaultAuthProfile } from "clank";
import type { Todo } from "./backend.ts";

export interface TodoViewProps {
  user: AuthUser<DefaultAuthProfile>;
  todos: Todo[];
  version: number;
  connected: boolean;
  add(title: string): void | Promise<void>;
  setDone(id: Todo["_id"], done: boolean, version: number): void | Promise<void>;
  remove(id: Todo["_id"], version: number): void | Promise<void>;
  logout(): void | Promise<void>;
}

export function TodoView(props: TodoViewProps) {
  const title = signal("");
  const submit = async (event: Event) => {
    event.preventDefault();
    const value = title.value.trim();
    if (!value) return;
    title.value = "";
    await props.add(value);
  };
  return (
    <main class="mx-auto min-h-screen max-w-3xl px-6 py-12 text-slate-950">
      <header class="flex items-start justify-between gap-6">
        <div>
          <p class="text-xs font-bold uppercase tracking-[.2em] text-emerald-600">Clank deployed app</p>
          <h1 class="mt-2 text-4xl font-semibold tracking-tight">__PROJECT_TITLE__</h1>
          <p class="mt-3 text-slate-500">
            Private to {props.user.profile.name || props.user.email}.
            {props.connected ? " Live sync connected." : " Reconnecting…"}
            <span class="sr-only"> Database snapshot {props.version}.</span>
          </p>
        </div>
        <button class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold" onClick={props.logout}>
          Sign out
        </button>
      </header>
      <form class="mt-10 flex gap-3" onSubmit={submit}>
        <input
          class="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 shadow-sm"
          placeholder="What needs doing?"
          maxlength={160}
          required
          bind:value={title}
          agentId="new-todo"
          agentLabel="New todo title"
        />
        <button class="rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white" type="submit" agentId="add-todo">
          Add
        </button>
      </form>
      <section class="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <For each={props.todos} by="_id" fallback={
          <p class="p-8 text-center text-slate-500">Your list is clear.</p>
        }>
          {(todo) => (
            <article class="flex items-center gap-3 border-b border-slate-100 p-4 last:border-0">
              <button
                class="h-6 w-6 rounded-full border border-slate-400 text-xs"
                onClick={() => props.setDone(todo._id, !todo.done, todo._version)}
                agentId={`todo-${todo._id}-toggle`}
                agentLabel={`${todo.done ? "Reopen" : "Complete"} ${todo.title}`}
              >
                {todo.done ? "✓" : ""}
              </button>
              <span classList={{ "flex-1": true, "line-through text-slate-400": todo.done }}>{todo.title}</span>
              <button
                class="text-sm font-medium text-rose-600"
                onClick={() => props.remove(todo._id, todo._version)}
                agentId={`todo-${todo._id}-remove`}
                agentLabel={`Remove ${todo.title}`}
              >
                Remove
              </button>
            </article>
          )}
        </For>
      </section>
    </main>
  );
}
