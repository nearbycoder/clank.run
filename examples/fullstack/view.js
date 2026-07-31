import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "@clank.run/framework";
import { For, signal } from "@clank.run/framework";
export function TodoApp(props) {
    const draft = signal("");
    const submit = (event)=>{
        event.preventDefault();
        const title = draft.peek().trim();
        if (!title) return;
        props.add(title);
        draft.value = "";
    };
    return __clankJSX("main", {
        "class": "mx-auto min-h-screen max-w-3xl px-5 py-14 text-slate-950 sm:py-20"
    }, __clankJSX("header", {
        "class": "mb-9 flex flex-wrap items-end justify-between gap-5"
    }, __clankJSX("div", {}, __clankJSX("div", {
        "class": "mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[.24em] text-orange-600"
    }, __clankJSX("span", {
        "class": "size-2 rounded-full bg-orange-500"
    }), " Clank full stack "), __clankJSX("h1", {
        "class": "text-5xl font-semibold tracking-[-.05em] sm:text-7xl"
    }, "Live work."), __clankJSX("p", {
        "class": "mt-4 max-w-xl text-slate-500"
    }, "Server-rendered TSX, inferred RPC, transactional SQLite, and live query updates.")), __clankJSX("div", {
        "class": "rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold shadow-sm"
    }, __clankJSX("span", {
        "class": __clankExpression(()=>props.connected ? "text-emerald-600" : "text-amber-600")
    }, __clankExpression(()=>props.connected ? "● synced" : "○ connecting")), __clankJSX("span", {
        "class": "sr-only"
    }, "database snapshot ", __clankExpression(()=>props.version)))), __clankJSX("section", {
        "class": "overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-2xl shadow-slate-200/70"
    }, __clankJSX("form", {
        "class": "flex gap-3 border-b border-slate-100 p-5 sm:p-6",
        "onSubmit": submit
    }, __clankJSX("input", {
        "class": "min-w-0 flex-1 rounded-full bg-slate-100 px-5 py-3 outline-none ring-orange-400 transition focus:ring-2",
        "placeholder": "Add something useful…",
        "bind:value": draft,
        "disabled": __clankExpression(()=>props.pending),
        "agentId": "live-todo-title",
        "agentLabel": "New live todo title"
    }), __clankJSX("button", {
        "class": "rounded-full bg-slate-950 px-6 py-3 font-semibold text-white transition hover:bg-orange-500 disabled:opacity-50",
        "type": "submit",
        "disabled": __clankExpression(()=>props.pending),
        "agentId": "add-live-todo",
        "agentLabel": "Add live todo"
    }, " Add ")), __clankJSX("ul", {
        "class": "divide-y divide-slate-100"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>props.todos),
        "by": "_id",
        "fallback": __clankJSX("li", {
            "class": "p-10 text-center text-slate-400"
        }, "The shared list is clear.")
    }, (todo)=>__clankJSX("li", {
            "class": "flex items-center gap-4 p-5 sm:px-6",
            "agentId": __clankExpression(()=>`live-todo-${todo._id}`),
            "agentLabel": __clankExpression(()=>todo.title)
        }, __clankJSX("button", {
            "class": "grid size-7 shrink-0 place-items-center rounded-full border border-slate-300 text-sm",
            "classList": __clankExpression(()=>({
                    "border-emerald-500 bg-emerald-500 text-white": todo.done
                })),
            "onClick": ()=>props.toggle(todo._id, todo._version),
            "agentLabel": __clankExpression(()=>`Toggle ${todo.title}`)
        }, __clankExpression(()=>todo.done ? "✓" : "")), __clankJSX("span", {
            "class": __clankExpression(()=>todo.done ? "min-w-0 flex-1 text-slate-400 line-through" : "min-w-0 flex-1")
        }, __clankExpression(()=>todo.title)), __clankJSX("button", {
            "class": "rounded-full px-3 py-1 text-sm text-slate-400 transition hover:bg-red-50 hover:text-red-600",
            "onClick": ()=>props.remove(todo._id, todo._version),
            "agentLabel": __clankExpression(()=>`Remove ${todo.title}`)
        }, " Remove ")))), __clankJSX("footer", {
        "class": "flex items-center justify-between gap-4 bg-slate-50 px-5 py-4 text-sm text-slate-500 sm:px-6"
    }, __clankJSX("span", {}, __clankExpression(()=>props.todos.filter((todo)=>!todo.done).length), " open · ", __clankExpression(()=>props.todos.length), " synced"), __clankJSX("button", {
        "class": "font-semibold text-slate-500 hover:text-slate-950 disabled:opacity-40",
        "disabled": __clankExpression(()=>props.pending || !props.todos.some((todo)=>todo.done)),
        "onClick": ()=>props.clearCompleted()
    }, " Clear completed "))), __clankJSX("p", {
        "class": "mt-6 text-center text-xs text-slate-400"
    }, "Open this URL in another tab. Mutations committed there stream here automatically."));
}


//# sourceURL=/home/nearby/Sites/clank/examples/fullstack/view.tsx