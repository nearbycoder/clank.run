/* @clankImportSource clank.run */
import { For, signal, type AuthUser, type DefaultAuthProfile, type Id } from "clank.run";
import type { Todo } from "./backend.ts";

export function TodoWorkspace(props: {
  user: AuthUser<DefaultAuthProfile>;
  profileName: string;
  todos: Todo[];
  version: number;
  connected: boolean;
  pending: boolean;
  error?: string;
  add(title: string): unknown;
  setDone(id: Id<"todos">, done: boolean, version: number): unknown;
  rename(id: Id<"todos">, title: string, version: number): Promise<boolean>;
  remove(id: Id<"todos">, version: number): unknown;
  clearCompleted(): unknown;
  updateProfile(displayName: string, version: number | null): Promise<boolean>;
  profileVersion: number | null;
  logout(): unknown;
}) {
  const draft = signal("");
  const editingProfile = signal(false);
  const profileDraft = signal("");
  const editingTodo = signal<Id<"todos"> | null>(null);
  const todoDraft = signal("");
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const title = draft.peek().trim();
    if (!title) return;
    props.add(title);
    draft.value = "";
  };
  const fallbackName = props.user.profile.name || props.user.email.split("@")[0];
  const editProfile = () => {
    profileDraft.value = props.profileName || fallbackName;
    editingProfile.value = true;
  };
  const saveProfile = async (event: SubmitEvent) => {
    event.preventDefault();
    const displayName = profileDraft.peek().trim();
    if (!displayName) return;
    if (await props.updateProfile(displayName, props.profileVersion)) {
      editingProfile.value = false;
    }
  };
  const editTodo = (todo: Todo) => {
    editingTodo.value = todo._id;
    todoDraft.value = todo.title;
  };
  const saveTodo = async (event: SubmitEvent, todo: Todo) => {
    event.preventDefault();
    const title = todoDraft.peek().trim();
    if (!title) return;
    if (await props.rename(todo._id, title, todo._version)) {
      editingTodo.value = null;
    }
  };

  return (
    <main class="mx-auto min-h-screen max-w-4xl px-5 py-12 text-slate-950 sm:py-16">
      <header class="mb-9 flex flex-wrap items-end justify-between gap-5">
        <div>
          <div class="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[.24em] text-violet-600">
            <span class="size-2 rounded-full bg-violet-500" />
            Clank auth + live data
          </div>
          <h1 class="text-5xl font-semibold tracking-[-.05em] sm:text-7xl">Make today count.</h1>
          <p class="mt-4 max-w-xl text-slate-500">
            Private to <strong class="font-semibold text-slate-700">{props.profileName || fallbackName}</strong>.
            Open this app in another browser and every committed change appears instantly.
          </p>
          {editingProfile.value ? (
            <form class="mt-4 flex max-w-md gap-2" onSubmit={saveProfile}>
              <label class="sr-only" for="profile-display-name">Display name</label>
              <input
                id="profile-display-name"
                class="min-w-0 flex-1 rounded-full border border-slate-300 bg-white px-4 py-2 outline-none ring-violet-400 focus:ring-2"
                maxlength={120}
                required
                bind:value={profileDraft}
                disabled={props.pending}
                agentId="profile-name"
                agentLabel="Profile display name"
              />
              <button
                class="rounded-full bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                type="submit"
                disabled={props.pending}
                agentId="profile-save"
                agentLabel="Save profile"
              >
                Save
              </button>
              <button
                class="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold"
                type="button"
                onClick={() => editingProfile.value = false}
                agentId="profile-cancel"
                agentLabel="Cancel profile edit"
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              class="mt-4 text-sm font-semibold text-violet-600 hover:text-violet-800"
              type="button"
              onClick={editProfile}
              agentId="profile-edit"
              agentLabel="Edit profile"
            >
              Edit profile
            </button>
          )}
        </div>
        <div class="flex items-center gap-3">
          <div
            class="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold shadow-sm"
            title={`Database snapshot ${props.version}`}
          >
            <span class={props.connected ? "text-emerald-600" : "text-amber-600"}>
              {props.connected ? "● synced" : "○ reconnecting"}
            </span>
            <span class="sr-only">database snapshot {props.version}</span>
          </div>
          <button
            class="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold shadow-sm hover:border-slate-300"
            onClick={() => props.logout()}
            agentId="auth-logout"
            agentLabel="Sign out"
          >
            Sign out
          </button>
        </div>
      </header>

      <section class="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-2xl shadow-slate-200/70">
        <form class="flex gap-3 border-b border-slate-100 p-5 sm:p-6" onSubmit={submit}>
          <input
            class="min-w-0 flex-1 rounded-full bg-slate-100 px-5 py-3 outline-none ring-violet-400 transition focus:ring-2"
            placeholder="What needs doing?"
            maxlength={160}
            bind:value={draft}
            disabled={props.pending}
            agentId="todo-title"
            agentLabel="New todo title"
          />
          <button
            class="rounded-full bg-slate-950 px-6 py-3 font-semibold text-white transition hover:bg-violet-600 disabled:opacity-50"
            type="submit"
            disabled={props.pending}
            agentId="todo-add"
            agentLabel="Add todo"
          >
            Add
          </button>
        </form>

        <p class="min-h-6 px-6 pt-3 text-sm text-rose-600" role="alert">{props.error || ""}</p>

        <ul class="divide-y divide-slate-100">
          <For
            each={props.todos}
            by="_id"
            fallback={<li class="p-12 text-center text-slate-400">Nothing here yet. Add your first task.</li>}
          >
            {(todo) => (
              <li
                class="flex flex-wrap items-center gap-4 p-5 sm:flex-nowrap sm:px-6"
                agentId={`todo-${todo._id}`}
                agentLabel={todo.title}
              >
                <button
                  class="grid size-7 shrink-0 place-items-center rounded-full border border-slate-300 text-sm"
                  classList={{ "border-emerald-500 bg-emerald-500 text-white": todo.done }}
                  onClick={() => props.setDone(todo._id, !todo.done, todo._version)}
                  agentLabel={`${todo.done ? "Reopen" : "Complete"} ${todo.title}`}
                >
                  {todo.done ? "✓" : ""}
                </button>
                {editingTodo.value === todo._id ? (
                  <form class="flex min-w-0 flex-1 gap-2" onSubmit={(event) => saveTodo(event, todo)}>
                    <label class="sr-only" for={`todo-edit-${todo._id}`}>Todo title</label>
                    <input
                      id={`todo-edit-${todo._id}`}
                      class="min-w-0 flex-1 rounded-full border border-slate-300 px-4 py-2 outline-none ring-violet-400 focus:ring-2"
                      maxlength={160}
                      required
                      bind:value={todoDraft}
                      disabled={props.pending}
                      agentLabel={`Edit ${todo.title}`}
                    />
                    <button
                      class="rounded-full bg-slate-950 px-3 py-1 text-sm font-semibold text-white"
                      type="submit"
                      disabled={props.pending}
                      agentLabel={`Save ${todo.title}`}
                    >
                      Save
                    </button>
                    <button
                      class="rounded-full px-3 py-1 text-sm text-slate-500"
                      type="button"
                      onClick={() => editingTodo.value = null}
                      agentLabel={`Cancel editing ${todo.title}`}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <span class={todo.done ? "min-w-0 flex-1 text-slate-400 line-through" : "min-w-0 flex-1"}>
                    {todo.title}
                  </span>
                )}
                <button
                  class="rounded-full px-3 py-1 text-sm text-slate-400 transition hover:bg-violet-50 hover:text-violet-700"
                  onClick={() => editTodo(todo)}
                  disabled={props.pending || editingTodo.value !== null}
                  agentLabel={`Edit ${todo.title}`}
                >
                  Edit
                </button>
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
          <span>{props.todos.filter((todo) => !todo.done).length} open · {props.todos.length} private</span>
          <button
            class="font-semibold text-slate-500 hover:text-slate-950 disabled:opacity-40"
            disabled={props.pending || !props.todos.some((todo) => todo.done)}
            onClick={() => props.clearCompleted()}
            agentId="todo-clear-completed"
            agentLabel="Clear completed todos"
          >
            Clear completed
          </button>
        </footer>
      </section>
    </main>
  );
}
