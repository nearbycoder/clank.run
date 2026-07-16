import {
  actionRunner,
  computed,
  createAgentBridge,
  createAgentSurface,
  defineAction,
  For,
  onMount,
  render,
  resource,
  s,
  Show,
  signal,
  type AgentSurface,
} from "/dist/index.js";

const count = signal(0, { name: "demo.count" });
const doubled = computed(() => count.value * 2, { name: "demo.doubled" });
const draft = signal("");

interface Task {
  id: string;
  title: string;
  done: boolean;
}

const tasks = signal<Task[]>([
  { id: crypto.randomUUID(), title: "Read the semantic action manifest", done: true },
  { id: crypto.randomUUID(), title: "Build something agents can understand", done: false },
]);

const changeCount = defineAction({
  name: "counter.change",
  description: "Change the visible counter by a signed integer amount.",
  input: s.object({ amount: s.number({ integer: true, min: -100, max: 100 }) }),
  output: s.object({ value: s.number({ integer: true }) }),
  sideEffects: "write",
  confirmation: "never",
  handler: ({ amount }) => ({ value: count.update((value) => value + amount) }),
});

const bridge = createAgentBridge([changeCount]);
const change = actionRunner(changeCount);
const thought = resource<string>(async (_parameter, { signal: abortSignal }) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 420);
    abortSignal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortSignal.reason);
    }, { once: true });
  });
  return "Only the text node that reads this resource changed.";
});

function CounterCard() {
  return (
    <section
      class="rounded-[2rem] border border-black/8 bg-white p-7 shadow-[0_24px_70px_rgba(23,33,59,.08)]"
      intent="counter-demo"
    >
      <div class="mb-8 flex items-start justify-between gap-4">
        <div>
          <p class="mb-2 text-xs font-bold uppercase tracking-[.22em] text-coral">Fine-grained state</p>
          <h2 class="text-2xl font-semibold tracking-tight">One signal, exact updates</h2>
        </div>
        <span class="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">live</span>
      </div>

      <div class="mb-7 flex items-end gap-5">
        <strong
          class="text-7xl font-semibold leading-none tabular-nums"
          agentId="counter-value"
          agentLabel="Current counter value"
        >
          {count.value}
        </strong>
        <div class="pb-1 text-sm text-slate-500">
          computed × 2 = <b class="text-ink">{doubled.value}</b>
        </div>
      </div>

      <div class="flex flex-wrap gap-3">
        <button
          class="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-700 disabled:opacity-50"
          onClick={() => change.run({ amount: 1 })}
          disabled={change.pending.value}
          agentId="increment-counter"
          agentAction="counter.change"
          agentLabel="Increase counter by one"
        >
          + Increase
        </button>
        <button
          class="rounded-full border border-black/10 px-5 py-2.5 text-sm font-semibold transition hover:bg-slate-50"
          onClick={() => change.run({ amount: -1 })}
          agentId="decrement-counter"
          agentAction="counter.change"
          agentLabel="Decrease counter by one"
        >
          − Decrease
        </button>
      </div>
    </section>
  );
}

function TasksCard() {
  const add = (event: Event) => {
    event.preventDefault();
    const title = draft.peek().trim();
    if (!title) return;
    tasks.update((items) => [...items, { id: crypto.randomUUID(), title, done: false }]);
    draft.value = "";
  };

  return (
    <section class="rounded-[2rem] border border-black/8 bg-ink p-7 text-white shadow-[0_24px_70px_rgba(23,33,59,.15)]">
      <p class="mb-2 text-xs font-bold uppercase tracking-[.22em] text-orange-300">Human-friendly mechanics</p>
      <h2 class="mb-6 text-2xl font-semibold tracking-tight">Reactive task list</h2>

      <form class="mb-6 flex gap-2" onSubmit={add}>
        <input
          class="min-w-0 flex-1 rounded-full border border-white/15 bg-white/10 px-4 py-2.5 text-sm text-white placeholder:text-slate-400 focus:border-orange-300"
          placeholder="Add a task…"
          bind:value={draft}
          agentId="task-title"
          agentLabel="New task title"
        />
        <button
          class="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold hover:bg-orange-400"
          type="submit"
          agentId="add-task"
          agentLabel="Add task"
        >
          Add
        </button>
      </form>

      <ul class="space-y-2">
        <For each={tasks.value} by="id" fallback={<li class="px-4 py-3 text-slate-400">Nothing to do yet.</li>}>
          {(task: Task) => (
            <li
              class="flex items-center gap-3 rounded-2xl bg-white/7 px-4 py-3"
              agentId={`task-${task.id}`}
              agentLabel={task.title}
            >
              <button
                class="grid size-5 place-items-center rounded-full border border-white/30 text-[10px]"
                classList={{ "bg-emerald-400 text-ink": task.done }}
                onClick={() => tasks.update((items) => items.map((entry) =>
                  entry.id === task.id ? { ...entry, done: !entry.done } : entry
                ))}
                agentLabel={`Toggle ${task.title}`}
              >
                {task.done ? "✓" : ""}
              </button>
              <span class={task.done ? "text-slate-400 line-through" : "text-slate-100"}>
                {task.title}
              </span>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

function AgentCard() {
  const inspection = signal("Inspect the mounted semantic UI contract.");
  let surface: AgentSurface;
  onMount(() => {
    surface = createAgentSurface(document.querySelector("#app")!);
  });

  return (
    <section class="rounded-[2rem] border border-black/8 bg-[#fff9ed] p-7 lg:col-span-2">
      <div class="grid gap-7 lg:grid-cols-[1fr_1.15fr]">
        <div>
          <p class="mb-2 text-xs font-bold uppercase tracking-[.22em] text-coral">Agent-native by design</p>
          <h2 class="mb-3 text-2xl font-semibold tracking-tight">No screenshots. No selector guessing.</h2>
          <p class="mb-5 max-w-xl text-sm leading-6 text-slate-600">
            Views expose semantic IDs and intents; actions expose validated JSON Schema contracts. Humans still get ordinary accessible HTML.
          </p>
          <button
            class="rounded-full border border-ink/15 bg-white px-5 py-2.5 text-sm font-semibold shadow-sm hover:border-ink/30"
            onClick={() => { inspection.value = JSON.stringify(surface.inspect(), null, 2); }}
            agentId="inspect-surface"
            agentLabel="Inspect semantic UI tree"
          >
            Inspect this UI
          </button>
        </div>
        <pre
          class="max-h-64 overflow-auto rounded-2xl bg-ink p-5 text-xs leading-5 text-sky-200"
          agentHidden
        >
          {inspection.value}
        </pre>
      </div>
      <div class="mt-6 border-t border-black/8 pt-5 text-sm text-slate-500">
        <span class="font-semibold text-ink">Async resource: </span>
        <Show when={thought.loading.value} fallback={thought.data.value}>
          <span class="animate-pulse">streaming a thought…</span>
        </Show>
      </div>
    </section>
  );
}

function App() {
  return (
    <div class="relative min-h-screen overflow-hidden">
      <div class="pointer-events-none absolute -left-24 -top-24 size-96 rounded-full bg-orange-200/50 blur-3xl" />
      <div class="pointer-events-none absolute -right-20 top-40 size-80 rounded-full bg-sky-200/50 blur-3xl" />
      <div class="relative mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-20">
        <header class="mb-12 max-w-3xl">
          <div class="mb-5 inline-flex items-center gap-2 rounded-full border border-black/8 bg-white/70 px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur">
            <span class="size-2 rounded-full bg-coral" /> CLANK / 0.6
          </div>
          <h1 class="mb-5 text-5xl font-semibold leading-[.98] tracking-[-.05em] sm:text-7xl">
            The web framework built for <span class="text-coral">people + agents.</span>
          </h1>
          <p class="max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Compiler-powered TSX, fine-grained reactivity, keyed DOM updates, validated AI actions, routing, and server primitives—with zero package dependencies.
          </p>
        </header>

        <div class="grid gap-5 lg:grid-cols-2">
          <CounterCard />
          <TasksCard />
          <AgentCard />
        </div>

        <footer class="mt-10 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <span>Built with Clank TSX and Tailwind utilities.</span>
          <code class="rounded-full bg-white/70 px-3 py-1.5">
            {bridge.manifest().actions.length} discoverable action · 0 dependencies
          </code>
        </footer>
      </div>
    </div>
  );
}

render(document.querySelector("#app")!, <App />);

Object.assign(globalThis, { clank: { count, tasks, bridge } });
