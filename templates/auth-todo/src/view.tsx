/* @clankImportSource @clank.run/framework */
import {
  For,
  computed,
  createApi,
  signal,
  type AuthUser,
  type DefaultAuthProfile,
} from "@clank.run/framework";
import type { backend, Todo } from "./backend.ts";

const projectTitle = __PROJECT_TITLE_JSON__;
const api = createApi<typeof backend>();

export interface TodoViewProps {
  user: AuthUser<DefaultAuthProfile>;
  todos: Todo[];
  version: number;
  connected: boolean;
  error?: string;
  add(title: string): boolean | void | Promise<boolean | void>;
  setDone(id: Todo["_id"], done: boolean, version: number): boolean | void | Promise<boolean | void>;
  remove(id: Todo["_id"], version: number): boolean | void | Promise<boolean | void>;
  logout(): void | Promise<void>;
}

export function TodoView(props: TodoViewProps) {
  const title = signal("");
  const adding = signal(false);
  const pending = signal(new Set<Todo["_id"]>());
  const localError = signal("");
  const status = signal("all");
  const search = signal("");
  const counts = computed(() => ({ all: props.todos.length, active: props.todos.filter((todo) => !todo.done).length, completed: props.todos.filter((todo) => todo.done).length }));
  const visible = computed(() => {
    const query = search.value.trim().slice(0, 160).toLowerCase();
    return props.todos.filter((todo) => (status.value === "all" || (status.value === "completed") === todo.done)
      && (!query || todo.title.toLowerCase().includes(query)));
  });
  const filters = [{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "completed", label: "Completed" }] as const;
  let titleInput: HTMLInputElement | undefined;
  const submit = async (event: Event) => {
    event.preventDefault();
    if (adding.peek()) return;
    const draft = title.peek();
    const value = draft.trim();
    if (!value) return;
    adding.value = true;
    localError.value = "";
    try {
      if (await props.add(value) === false) {
        localError.value = "Could not add the todo. Your draft is still here.";
        titleInput?.focus();
      } else if (title.peek() === draft) title.value = "";
    } catch (reason) {
      localError.value = reason instanceof Error ? reason.message : "Could not add the todo. Try again.";
      titleInput?.focus();
    } finally { adding.value = false; }
  };
  const mutateRow = async (id: Todo["_id"], operation: () => boolean | void | Promise<boolean | void>) => {
    if (pending.peek().has(id)) return;
    pending.value = new Set([...pending.peek(), id]);
    localError.value = "";
    try {
      if (await operation() === false) localError.value = "Could not update the todo. Try again.";
    } catch (reason) {
      localError.value = reason instanceof Error ? reason.message : "Could not update the todo. Try again.";
    } finally {
      const next = new Set(pending.peek());
      next.delete(id);
      pending.value = next;
    }
  };
  return (
    <main class="mx-auto min-h-screen max-w-3xl px-6 py-12 text-slate-950">
      <header class="flex items-start justify-between gap-6">
        <div>
          <p class="text-xs font-bold uppercase tracking-[.2em] text-emerald-600">Clank deployed app</p>
          <h1 class="mt-2 text-4xl font-semibold tracking-tight">{projectTitle}</h1>
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
      <p role="alert" class="mt-4 text-sm text-rose-700" hidden={!(props.error || localError.value)}>{props.error || localError.value}</p>
      <form class="mt-10 flex gap-3" onSubmit={submit} aria-busy={adding.value}>
        <input
          class="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 shadow-sm"
          placeholder="What needs doing?"
          maxlength={160}
          required
          readonly={adding.value}
          ref={(element: HTMLInputElement) => { titleInput = element; }}
          bind:value={title}
          agentId="new-todo"
          agentLabel="New todo title"
        />
        <button
          class="rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white"
          type="submit"
          disabled={adding.value}
          agentId="add-todo"
          agentAction={api.todos.add}
        >
          {adding.value ? "Adding…" : "Add"}
        </button>
      </form>
      <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap gap-2" role="group" aria-label="Todo completion filter">
          <For each={filters} by="value">{(filter) => <button type="button" class="rounded-lg border border-slate-300 px-3 py-2 text-sm" aria-pressed={status.value === filter.value} onClick={() => { status.value = filter.value; }} agentId={`todos-${filter.value}`}>
            {filter.label} ({counts.value[filter.value]})
          </button>}</For>
        </div>
        <label class="flex items-center gap-2 text-sm">Search todos<input type="search" class="min-w-0 rounded-lg border border-slate-300 px-3 py-2" maxlength={160} bind:value={search} agentId="todo-search" /></label>
      </div>
      <p class="mt-3 text-sm text-slate-500" role="status">Showing {visible.value.length} of {counts.value.all} todos.</p>
      <section class="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <For each={visible.value} by="_id" fallback={
          <p class="p-8 text-center text-slate-500">{props.todos.length ? "No todos match these filters." : "Your list is clear."}</p>
        }>
          {(todo) => (
            <article class="flex items-center gap-3 border-b border-slate-100 p-4 last:border-0" aria-busy={pending.value.has(todo._id)}>
              <button
                class="h-6 w-6 rounded-full border border-slate-400 text-xs"
                disabled={pending.value.has(todo._id)}
                onClick={() => mutateRow(todo._id, () => props.setDone(todo._id, !todo.done, todo._version))}
                agentId={`todo-${todo._id}-toggle`}
                agentLabel={`${todo.done ? "Reopen" : "Complete"} ${todo.title}`}
                agentAction={api.todos.setDone}
              >
                {todo.done ? "✓" : ""}
              </button>
              <span classList={{ "flex-1": true, "line-through text-slate-400": todo.done }}>{todo.title}</span>
              <button
                class="text-sm font-medium text-rose-600"
                disabled={pending.value.has(todo._id)}
                onClick={() => mutateRow(todo._id, () => props.remove(todo._id, todo._version))}
                agentId={`todo-${todo._id}-remove`}
                agentLabel={`Remove ${todo.title}`}
                agentAction={api.todos.remove}
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
