import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "/dist/index.js";
import { computed, For, render, signal } from "/dist/index.js";
const draft = signal("");
const todos = signal([
    {
        id: crypto.randomUUID(),
        title: "Try Clank TSX",
        done: true
    },
    {
        id: crypto.randomUUID(),
        title: "Ship a fine-grained app",
        done: false
    }
]);
const remaining = computed(()=>todos.value.filter((todo)=>!todo.done).length);
function addTodo(event) {
    event.preventDefault();
    const title = draft.peek().trim();
    if (!title) return;
    todos.update((items)=>[
            ...items,
            {
                id: crypto.randomUUID(),
                title,
                done: false
            }
        ]);
    draft.value = "";
}
function toggleTodo(id) {
    todos.update((items)=>items.map((todo)=>todo.id === id ? {
                ...todo,
                done: !todo.done
            } : todo));
}
function removeTodo(id) {
    todos.update((items)=>items.filter((todo)=>todo.id !== id));
}
function App() {
    return __clankJSX("main", {
        "class": "mx-auto min-h-screen max-w-2xl px-5 py-16 text-slate-900"
    }, __clankJSX("header", {
        "class": "mb-8"
    }, __clankJSX("p", {
        "class": "mb-2 text-xs font-bold uppercase tracking-[.24em] text-orange-500"
    }, "Clank example"), __clankJSX("h1", {
        "class": "text-5xl font-semibold tracking-tight"
    }, "Things to do"), __clankJSX("p", {
        "class": "mt-3 text-slate-500"
    }, "TSX ergonomics with direct, keyed DOM updates.")), __clankJSX("section", {
        "class": "overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60"
    }, __clankJSX("form", {
        "class": "flex gap-3 border-b border-slate-100 p-5",
        "onSubmit": addTodo
    }, __clankJSX("input", {
        "class": "min-w-0 flex-1 rounded-full bg-slate-100 px-5 py-3 outline-none ring-orange-400 focus:ring-2",
        "placeholder": "What needs doing?",
        "bind:value": draft,
        "agentId": "todo-title",
        "agentLabel": "New todo title"
    }), __clankJSX("button", {
        "class": "rounded-full bg-slate-900 px-6 py-3 font-semibold text-white hover:bg-orange-500",
        "type": "submit",
        "agentId": "add-todo",
        "agentLabel": "Add todo"
    }, " Add ")), __clankJSX("ul", {
        "class": "divide-y divide-slate-100"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>todos.value),
        "by": "id",
        "fallback": __clankJSX("li", {
            "class": "p-8 text-center text-slate-400"
        }, "All clear.")
    }, (todo)=>__clankJSX("li", {
            "class": "flex items-center gap-4 p-5",
            "agentId": __clankExpression(()=>`todo-${todo.id}`),
            "agentLabel": __clankExpression(()=>todo.title)
        }, __clankJSX("button", {
            "class": "grid size-7 shrink-0 place-items-center rounded-full border border-slate-300 text-sm",
            "classList": __clankExpression(()=>({
                    "border-emerald-500 bg-emerald-500 text-white": todo.done
                })),
            "onClick": ()=>toggleTodo(todo.id),
            "agentLabel": __clankExpression(()=>`Toggle ${todo.title}`)
        }, __clankExpression(()=>todo.done ? "✓" : "")), __clankJSX("span", {
            "class": __clankExpression(()=>todo.done ? "flex-1 text-slate-400 line-through" : "flex-1")
        }, __clankExpression(()=>todo.title)), __clankJSX("button", {
            "class": "rounded-full px-3 py-1 text-sm text-slate-400 hover:bg-red-50 hover:text-red-600",
            "onClick": ()=>removeTodo(todo.id),
            "agentLabel": __clankExpression(()=>`Remove ${todo.title}`)
        }, " Remove ")))), __clankJSX("footer", {
        "class": "flex items-center justify-between bg-slate-50 px-5 py-4 text-sm text-slate-500"
    }, __clankJSX("span", {}, __clankExpression(()=>remaining.value), " remaining"), __clankJSX("button", {
        "class": "font-medium hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40",
        "disabled": __clankExpression(()=>remaining.value === todos.value.length),
        "onClick": ()=>todos.update((items)=>items.filter((todo)=>!todo.done))
    }, " Clear completed "))));
}
render(document.querySelector("#app"), __clankJSX(App, {}));


//# sourceURL=/home/nearby/Sites/clank/examples/todo/app.tsx