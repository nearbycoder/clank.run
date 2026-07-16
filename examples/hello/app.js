import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "/dist/index.js";
import { actionRunner, computed, createAgentBridge, createAgentSurface, defineAction, For, onMount, render, resource, s, Show, signal } from "/dist/index.js";
const count = signal(0, {
    name: "demo.count"
});
const doubled = computed(()=>count.value * 2, {
    name: "demo.doubled"
});
const draft = signal("");
const tasks = signal([
    {
        id: crypto.randomUUID(),
        title: "Read the semantic action manifest",
        done: true
    },
    {
        id: crypto.randomUUID(),
        title: "Build something agents can understand",
        done: false
    }
]);
const changeCount = defineAction({
    name: "counter.change",
    description: "Change the visible counter by a signed integer amount.",
    input: s.object({
        amount: s.number({
            integer: true,
            min: -100,
            max: 100
        })
    }),
    output: s.object({
        value: s.number({
            integer: true
        })
    }),
    sideEffects: "write",
    confirmation: "never",
    handler: ({ amount })=>({
            value: count.update((value)=>value + amount)
        })
});
const bridge = createAgentBridge([
    changeCount
]);
const change = actionRunner(changeCount);
const thought = resource(async (_parameter, { signal: abortSignal })=>{
    await new Promise((resolve, reject)=>{
        const timer = setTimeout(resolve, 420);
        abortSignal.addEventListener("abort", ()=>{
            clearTimeout(timer);
            reject(abortSignal.reason);
        }, {
            once: true
        });
    });
    return "Only the text node that reads this resource changed.";
});
function CounterCard() {
    return __clankJSX("section", {
        "class": "rounded-[2rem] border border-black/8 bg-white p-7 shadow-[0_24px_70px_rgba(23,33,59,.08)]",
        "intent": "counter-demo"
    }, __clankJSX("div", {
        "class": "mb-8 flex items-start justify-between gap-4"
    }, __clankJSX("div", {}, __clankJSX("p", {
        "class": "mb-2 text-xs font-bold uppercase tracking-[.22em] text-coral"
    }, "Fine-grained state"), __clankJSX("h2", {
        "class": "text-2xl font-semibold tracking-tight"
    }, "One signal, exact updates")), __clankJSX("span", {
        "class": "rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"
    }, "live")), __clankJSX("div", {
        "class": "mb-7 flex items-end gap-5"
    }, __clankJSX("strong", {
        "class": "text-7xl font-semibold leading-none tabular-nums",
        "agentId": "counter-value",
        "agentLabel": "Current counter value"
    }, __clankExpression(()=>count.value)), __clankJSX("div", {
        "class": "pb-1 text-sm text-slate-500"
    }, " computed × 2 = ", __clankJSX("b", {
        "class": "text-ink"
    }, __clankExpression(()=>doubled.value)))), __clankJSX("div", {
        "class": "flex flex-wrap gap-3"
    }, __clankJSX("button", {
        "class": "rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-700 disabled:opacity-50",
        "onClick": ()=>change.run({
                amount: 1
            }),
        "disabled": __clankExpression(()=>change.pending.value),
        "agentId": "increment-counter",
        "agentAction": "counter.change",
        "agentLabel": "Increase counter by one"
    }, " + Increase "), __clankJSX("button", {
        "class": "rounded-full border border-black/10 px-5 py-2.5 text-sm font-semibold transition hover:bg-slate-50",
        "onClick": ()=>change.run({
                amount: -1
            }),
        "agentId": "decrement-counter",
        "agentAction": "counter.change",
        "agentLabel": "Decrease counter by one"
    }, " − Decrease ")));
}
function TasksCard() {
    const add = (event)=>{
        event.preventDefault();
        const title = draft.peek().trim();
        if (!title) return;
        tasks.update((items)=>[
                ...items,
                {
                    id: crypto.randomUUID(),
                    title,
                    done: false
                }
            ]);
        draft.value = "";
    };
    return __clankJSX("section", {
        "class": "rounded-[2rem] border border-black/8 bg-ink p-7 text-white shadow-[0_24px_70px_rgba(23,33,59,.15)]"
    }, __clankJSX("p", {
        "class": "mb-2 text-xs font-bold uppercase tracking-[.22em] text-orange-300"
    }, "Human-friendly mechanics"), __clankJSX("h2", {
        "class": "mb-6 text-2xl font-semibold tracking-tight"
    }, "Reactive task list"), __clankJSX("form", {
        "class": "mb-6 flex gap-2",
        "onSubmit": add
    }, __clankJSX("input", {
        "class": "min-w-0 flex-1 rounded-full border border-white/15 bg-white/10 px-4 py-2.5 text-sm text-white placeholder:text-slate-400 focus:border-orange-300",
        "placeholder": "Add a task…",
        "bind:value": draft,
        "agentId": "task-title",
        "agentLabel": "New task title"
    }), __clankJSX("button", {
        "class": "rounded-full bg-coral px-5 py-2.5 text-sm font-semibold hover:bg-orange-400",
        "type": "submit",
        "agentId": "add-task",
        "agentLabel": "Add task"
    }, " Add ")), __clankJSX("ul", {
        "class": "space-y-2"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>tasks.value),
        "by": "id",
        "fallback": __clankJSX("li", {
            "class": "px-4 py-3 text-slate-400"
        }, "Nothing to do yet.")
    }, (task)=>__clankJSX("li", {
            "class": "flex items-center gap-3 rounded-2xl bg-white/7 px-4 py-3",
            "agentId": __clankExpression(()=>`task-${task.id}`),
            "agentLabel": __clankExpression(()=>task.title)
        }, __clankJSX("button", {
            "class": "grid size-5 place-items-center rounded-full border border-white/30 text-[10px]",
            "classList": __clankExpression(()=>({
                    "bg-emerald-400 text-ink": task.done
                })),
            "onClick": ()=>tasks.update((items)=>items.map((entry)=>entry.id === task.id ? {
                            ...entry,
                            done: !entry.done
                        } : entry)),
            "agentLabel": __clankExpression(()=>`Toggle ${task.title}`)
        }, __clankExpression(()=>task.done ? "✓" : "")), __clankJSX("span", {
            "class": __clankExpression(()=>task.done ? "text-slate-400 line-through" : "text-slate-100")
        }, __clankExpression(()=>task.title))))));
}
function AgentCard() {
    const inspection = signal("Inspect the mounted semantic UI contract.");
    let surface;
    onMount(()=>{
        surface = createAgentSurface(document.querySelector("#app"));
    });
    return __clankJSX("section", {
        "class": "rounded-[2rem] border border-black/8 bg-[#fff9ed] p-7 lg:col-span-2"
    }, __clankJSX("div", {
        "class": "grid gap-7 lg:grid-cols-[1fr_1.15fr]"
    }, __clankJSX("div", {}, __clankJSX("p", {
        "class": "mb-2 text-xs font-bold uppercase tracking-[.22em] text-coral"
    }, "Agent-native by design"), __clankJSX("h2", {
        "class": "mb-3 text-2xl font-semibold tracking-tight"
    }, "No screenshots. No selector guessing."), __clankJSX("p", {
        "class": "mb-5 max-w-xl text-sm leading-6 text-slate-600"
    }, " Views expose semantic IDs and intents; actions expose validated JSON Schema contracts. Humans still get ordinary accessible HTML. "), __clankJSX("button", {
        "class": "rounded-full border border-ink/15 bg-white px-5 py-2.5 text-sm font-semibold shadow-sm hover:border-ink/30",
        "onClick": ()=>{
            inspection.value = JSON.stringify(surface.inspect(), null, 2);
        },
        "agentId": "inspect-surface",
        "agentLabel": "Inspect semantic UI tree"
    }, " Inspect this UI ")), __clankJSX("pre", {
        "class": "max-h-64 overflow-auto rounded-2xl bg-ink p-5 text-xs leading-5 text-sky-200",
        "agentHidden": true
    }, __clankExpression(()=>inspection.value))), __clankJSX("div", {
        "class": "mt-6 border-t border-black/8 pt-5 text-sm text-slate-500"
    }, __clankJSX("span", {
        "class": "font-semibold text-ink"
    }, "Async resource: "), __clankJSX(Show, {
        "when": __clankExpression(()=>thought.loading.value),
        "fallback": __clankExpression(()=>thought.data.value)
    }, __clankJSX("span", {
        "class": "animate-pulse"
    }, "streaming a thought…"))));
}
function App() {
    return __clankJSX("div", {
        "class": "relative min-h-screen overflow-hidden"
    }, __clankJSX("div", {
        "class": "pointer-events-none absolute -left-24 -top-24 size-96 rounded-full bg-orange-200/50 blur-3xl"
    }), __clankJSX("div", {
        "class": "pointer-events-none absolute -right-20 top-40 size-80 rounded-full bg-sky-200/50 blur-3xl"
    }), __clankJSX("div", {
        "class": "relative mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-20"
    }, __clankJSX("header", {
        "class": "mb-12 max-w-3xl"
    }, __clankJSX("div", {
        "class": "mb-5 inline-flex items-center gap-2 rounded-full border border-black/8 bg-white/70 px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur"
    }, __clankJSX("span", {
        "class": "size-2 rounded-full bg-coral"
    }), " CLANK / 0.6 "), __clankJSX("h1", {
        "class": "mb-5 text-5xl font-semibold leading-[.98] tracking-[-.05em] sm:text-7xl"
    }, " The web framework built for ", __clankJSX("span", {
        "class": "text-coral"
    }, "people + agents.")), __clankJSX("p", {
        "class": "max-w-2xl text-base leading-7 text-slate-600 sm:text-lg"
    }, " Compiler-powered TSX, fine-grained reactivity, keyed DOM updates, validated AI actions, routing, and server primitives—with zero package dependencies. ")), __clankJSX("div", {
        "class": "grid gap-5 lg:grid-cols-2"
    }, __clankJSX(CounterCard, {}), __clankJSX(TasksCard, {}), __clankJSX(AgentCard, {})), __clankJSX("footer", {
        "class": "mt-10 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500"
    }, __clankJSX("span", {}, "Built with Clank TSX and Tailwind utilities."), __clankJSX("code", {
        "class": "rounded-full bg-white/70 px-3 py-1.5"
    }, __clankExpression(()=>bridge.manifest().actions.length), " discoverable action · 0 dependencies "))));
}
render(document.querySelector("#app"), __clankJSX(App, {}));
Object.assign(globalThis, {
    clank: {
        count,
        tasks,
        bridge
    }
});


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9oZWxsby9hcHAudHN4Il0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLFNBQVMsT0FBTyxVQUFVLEVBQUUsWUFBWSxlQUFlLEVBQUUsY0FBYyxpQkFBaUIsUUFBUSxpQkFBaUI7QUFDakgsU0FDRSxZQUFZLEVBQ1osUUFBUSxFQUNSLGlCQUFpQixFQUNqQixrQkFBa0IsRUFDbEIsWUFBWSxFQUNaLEdBQUcsRUFDSCxPQUFPLEVBQ1AsTUFBTSxFQUNOLFFBQVEsRUFDUixDQUFDLEVBQ0QsSUFBSSxFQUNKLE1BQU0sUUFFRCxpQkFBaUI7QUFFeEIsTUFBTSxRQUFRLE9BQU8sR0FBRztJQUFFLE1BQU07QUFBYTtBQUM3QyxNQUFNLFVBQVUsU0FBUyxJQUFNLE1BQU0sS0FBSyxHQUFHLEdBQUc7SUFBRSxNQUFNO0FBQWU7QUFDdkUsTUFBTSxRQUFRLE9BQU87QUFRckIsTUFBTSxRQUFRLE9BQWU7SUFDM0I7UUFBRSxJQUFJLE9BQU8sVUFBVTtRQUFJLE9BQU87UUFBcUMsTUFBTTtJQUFLO0lBQ2xGO1FBQUUsSUFBSSxPQUFPLFVBQVU7UUFBSSxPQUFPO1FBQXlDLE1BQU07SUFBTTtDQUN4RjtBQUVELE1BQU0sY0FBYyxhQUFhO0lBQy9CLE1BQU07SUFDTixhQUFhO0lBQ2IsT0FBTyxFQUFFLE1BQU0sQ0FBQztRQUFFLFFBQVEsRUFBRSxNQUFNLENBQUM7WUFBRSxTQUFTO1lBQU0sS0FBSyxDQUFDO1lBQUssS0FBSztRQUFJO0lBQUc7SUFDM0UsUUFBUSxFQUFFLE1BQU0sQ0FBQztRQUFFLE9BQU8sRUFBRSxNQUFNLENBQUM7WUFBRSxTQUFTO1FBQUs7SUFBRztJQUN0RCxhQUFhO0lBQ2IsY0FBYztJQUNkLFNBQVMsQ0FBQyxFQUFFLE1BQU0sRUFBRSxHQUFLLENBQUM7WUFBRSxPQUFPLE1BQU0sTUFBTSxDQUFDLENBQUMsUUFBVSxRQUFRO1FBQVEsQ0FBQztBQUM5RTtBQUVBLE1BQU0sU0FBUyxr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