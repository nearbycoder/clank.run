/* @clankImportSource @clank.run/framework */
import { computed, signal } from "@clank.run/framework";

const projectTitle = __PROJECT_TITLE_JSON__;

export function StarterView() {
  const count = signal(0);
  const label = computed(() => `${count.value} click${count.value === 1 ? "" : "s"}`);
  return (
    <main class="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16 text-slate-950">
      <section class="w-full rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-12">
        <p class="text-xs font-bold uppercase tracking-[.22em] text-emerald-600">Clank starter</p>
        <h1 class="mt-4 text-5xl font-semibold tracking-tight">{projectTitle}</h1>
        <p class="mt-5 max-w-xl text-lg leading-8 text-slate-600">
          Server rendered, hydrated in place, and ready for your product.
        </p>
        <button
          class="mt-9 rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white"
          type="button"
          onClick={() => count.value++}
          agentId="starter-counter"
          agentLabel="Increase the starter counter"
        >
          {label.value}
        </button>
      </section>
    </main>
  );
}
