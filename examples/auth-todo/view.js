import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "clank.run";
/* @clankImportSource clank.run */ import { For, signal } from "clank.run";
export function TodoWorkspace(props) {
    const draft = signal("");
    const editingProfile = signal(false);
    const profileDraft = signal("");
    const editingTodo = signal(null);
    const todoDraft = signal("");
    const submit = (event)=>{
        event.preventDefault();
        const title = draft.peek().trim();
        if (!title) return;
        props.add(title);
        draft.value = "";
    };
    const fallbackName = props.user.profile.name || props.user.email.split("@")[0];
    const editProfile = ()=>{
        profileDraft.value = props.profileName || fallbackName;
        editingProfile.value = true;
    };
    const saveProfile = async (event)=>{
        event.preventDefault();
        const displayName = profileDraft.peek().trim();
        if (!displayName) return;
        if (await props.updateProfile(displayName, props.profileVersion)) {
            editingProfile.value = false;
        }
    };
    const editTodo = (todo)=>{
        editingTodo.value = todo._id;
        todoDraft.value = todo.title;
    };
    const saveTodo = async (event, todo)=>{
        event.preventDefault();
        const title = todoDraft.peek().trim();
        if (!title) return;
        if (await props.rename(todo._id, title, todo._version)) {
            editingTodo.value = null;
        }
    };
    return __clankJSX("main", {
        "class": "mx-auto min-h-screen max-w-4xl px-5 py-12 text-slate-950 sm:py-16"
    }, __clankJSX("header", {
        "class": "mb-9 flex flex-wrap items-end justify-between gap-5"
    }, __clankJSX("div", {}, __clankJSX("div", {
        "class": "mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[.24em] text-violet-600"
    }, __clankJSX("span", {
        "class": "size-2 rounded-full bg-violet-500"
    }), " Clank auth + live data "), __clankJSX("h1", {
        "class": "text-5xl font-semibold tracking-[-.05em] sm:text-7xl"
    }, "Make today count."), __clankJSX("p", {
        "class": "mt-4 max-w-xl text-slate-500"
    }, " Private to ", __clankJSX("strong", {
        "class": "font-semibold text-slate-700"
    }, __clankExpression(()=>props.profileName || fallbackName)), ". Open this app in another browser and every committed change appears instantly. "), __clankExpression(()=>editingProfile.value ? __clankJSX("form", {
            "class": "mt-4 flex max-w-md gap-2",
            "onSubmit": saveProfile
        }, __clankJSX("label", {
            "class": "sr-only",
            "for": "profile-display-name"
        }, "Display name"), __clankJSX("input", {
            "id": "profile-display-name",
            "class": "min-w-0 flex-1 rounded-full border border-slate-300 bg-white px-4 py-2 outline-none ring-violet-400 focus:ring-2",
            "maxlength": 120,
            "required": true,
            "bind:value": profileDraft,
            "disabled": __clankExpression(()=>props.pending),
            "agentId": "profile-name",
            "agentLabel": "Profile display name"
        }), __clankJSX("button", {
            "class": "rounded-full bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50",
            "type": "submit",
            "disabled": __clankExpression(()=>props.pending),
            "agentId": "profile-save",
            "agentLabel": "Save profile"
        }, " Save "), __clankJSX("button", {
            "class": "rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold",
            "type": "button",
            "onClick": ()=>editingProfile.value = false,
            "agentId": "profile-cancel",
            "agentLabel": "Cancel profile edit"
        }, " Cancel ")) : __clankJSX("button", {
            "class": "mt-4 text-sm font-semibold text-violet-600 hover:text-violet-800",
            "type": "button",
            "onClick": editProfile,
            "agentId": "profile-edit",
            "agentLabel": "Edit profile"
        }, " Edit profile "))), __clankJSX("div", {
        "class": "flex items-center gap-3"
    }, __clankJSX("div", {
        "class": "rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold shadow-sm",
        "title": __clankExpression(()=>`Database snapshot ${props.version}`)
    }, __clankJSX("span", {
        "class": __clankExpression(()=>props.connected ? "text-emerald-600" : "text-amber-600")
    }, __clankExpression(()=>props.connected ? "● synced" : "○ reconnecting")), __clankJSX("span", {
        "class": "sr-only"
    }, "database snapshot ", __clankExpression(()=>props.version))), __clankJSX("button", {
        "class": "rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold shadow-sm hover:border-slate-300",
        "onClick": ()=>props.logout(),
        "agentId": "auth-logout",
        "agentLabel": "Sign out"
    }, " Sign out "))), __clankJSX("section", {
        "class": "overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-2xl shadow-slate-200/70"
    }, __clankJSX("form", {
        "class": "flex gap-3 border-b border-slate-100 p-5 sm:p-6",
        "onSubmit": submit
    }, __clankJSX("input", {
        "class": "min-w-0 flex-1 rounded-full bg-slate-100 px-5 py-3 outline-none ring-violet-400 transition focus:ring-2",
        "placeholder": "What needs doing?",
        "maxlength": 160,
        "bind:value": draft,
        "disabled": __clankExpression(()=>props.pending),
        "agentId": "todo-title",
        "agentLabel": "New todo title"
    }), __clankJSX("button", {
        "class": "rounded-full bg-slate-950 px-6 py-3 font-semibold text-white transition hover:bg-violet-600 disabled:opacity-50",
        "type": "submit",
        "disabled": __clankExpression(()=>props.pending),
        "agentId": "todo-add",
        "agentLabel": "Add todo"
    }, " Add ")), __clankJSX("p", {
        "class": "min-h-6 px-6 pt-3 text-sm text-rose-600",
        "role": "alert"
    }, __clankExpression(()=>props.error || "")), __clankJSX("ul", {
        "class": "divide-y divide-slate-100"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>props.todos),
        "by": "_id",
        "fallback": __clankJSX("li", {
            "class": "p-12 text-center text-slate-400"
        }, "Nothing here yet. Add your first task.")
    }, (todo)=>__clankJSX("li", {
            "class": "flex flex-wrap items-center gap-4 p-5 sm:flex-nowrap sm:px-6",
            "agentId": __clankExpression(()=>`todo-${todo._id}`),
            "agentLabel": __clankExpression(()=>todo.title)
        }, __clankJSX("button", {
            "class": "grid size-7 shrink-0 place-items-center rounded-full border border-slate-300 text-sm",
            "classList": __clankExpression(()=>({
                    "border-emerald-500 bg-emerald-500 text-white": todo.done
                })),
            "onClick": ()=>props.setDone(todo._id, !todo.done, todo._version),
            "agentLabel": __clankExpression(()=>`${todo.done ? "Reopen" : "Complete"} ${todo.title}`)
        }, __clankExpression(()=>todo.done ? "✓" : "")), __clankExpression(()=>editingTodo.value === todo._id ? __clankJSX("form", {
                "class": "flex min-w-0 flex-1 gap-2",
                "onSubmit": (event)=>saveTodo(event, todo)
            }, __clankJSX("label", {
                "class": "sr-only",
                "for": __clankExpression(()=>`todo-edit-${todo._id}`)
            }, "Todo title"), __clankJSX("input", {
                "id": __clankExpression(()=>`todo-edit-${todo._id}`),
                "class": "min-w-0 flex-1 rounded-full border border-slate-300 px-4 py-2 outline-none ring-violet-400 focus:ring-2",
                "maxlength": 160,
                "required": true,
                "bind:value": todoDraft,
                "disabled": __clankExpression(()=>props.pending),
                "agentLabel": __clankExpression(()=>`Edit ${todo.title}`)
            }), __clankJSX("button", {
                "class": "rounded-full bg-slate-950 px-3 py-1 text-sm font-semibold text-white",
                "type": "submit",
                "disabled": __clankExpression(()=>props.pending),
                "agentLabel": __clankExpression(()=>`Save ${todo.title}`)
            }, " Save "), __clankJSX("button", {
                "class": "rounded-full px-3 py-1 text-sm text-slate-500",
                "type": "button",
                "onClick": ()=>editingTodo.value = null,
                "agentLabel": __clankExpression(()=>`Cancel editing ${todo.title}`)
            }, " Cancel ")) : __clankJSX("span", {
                "class": __clankExpression(()=>todo.done ? "min-w-0 flex-1 text-slate-400 line-through" : "min-w-0 flex-1")
            }, __clankExpression(()=>todo.title))), __clankJSX("button", {
            "class": "rounded-full px-3 py-1 text-sm text-slate-400 transition hover:bg-violet-50 hover:text-violet-700",
            "onClick": ()=>editTodo(todo),
            "disabled": __clankExpression(()=>props.pending || editingTodo.value !== null),
            "agentLabel": __clankExpression(()=>`Edit ${todo.title}`)
        }, " Edit "), __clankJSX("button", {
            "class": "rounded-full px-3 py-1 text-sm text-slate-400 transition hover:bg-red-50 hover:text-red-600",
            "onClick": ()=>props.remove(todo._id, todo._version),
            "agentLabel": __clankExpression(()=>`Remove ${todo.title}`)
        }, " Remove ")))), __clankJSX("footer", {
        "class": "flex items-center justify-between gap-4 bg-slate-50 px-5 py-4 text-sm text-slate-500 sm:px-6"
    }, __clankJSX("span", {}, __clankExpression(()=>props.todos.filter((todo)=>!todo.done).length), " open · ", __clankExpression(()=>props.todos.length), " private"), __clankJSX("button", {
        "class": "font-semibold text-slate-500 hover:text-slate-950 disabled:opacity-40",
        "disabled": __clankExpression(()=>props.pending || !props.todos.some((todo)=>todo.done)),
        "onClick": ()=>props.clearCompleted(),
        "agentId": "todo-clear-completed",
        "agentLabel": "Clear completed todos"
    }, " Clear completed "))));
}


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vdmlldy50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsU0FBUyxPQUFPLFVBQVUsRUFBRSxZQUFZLGVBQWUsRUFBRSxjQUFjLGlCQUFpQixRQUFRLFlBQVk7QUFDNUcsZ0NBQWdDLEdBQ2hDLFNBQVMsR0FBRyxFQUFFLE1BQU0sUUFBeUQsWUFBWTtBQUd6RixPQUFPLFNBQVMsY0FBYyxLQWdCN0I7SUFDQyxNQUFNLFFBQVEsT0FBTztJQUNyQixNQUFNLGlCQUFpQixPQUFPO0lBQzlCLE1BQU0sZUFBZSxPQUFPO0lBQzVCLE1BQU0sY0FBYyxPQUEyQjtJQUMvQyxNQUFNLFlBQVksT0FBTztJQUN6QixNQUFNLFNBQVMsQ0FBQztRQUNkLE1BQU0sY0FBYztRQUNwQixNQUFNLFFBQVEsTUFBTSxJQUFJLEdBQUcsSUFBSTtRQUMvQixJQUFJLENBQUMsT0FBTztRQUNaLE1BQU0sR0FBRyxDQUFDO1FBQ1YsTUFBTSxLQUFLLEdBQUc7SUFDaEI7SUFDQSxNQUFNLGVBQWUsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksSUFBSSxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFO0lBQzlFLE1BQU0sY0FBYztRQUNsQixhQUFhLEtBQUssR0FBRyxNQUFNLFdBQVcsSUFBSTtRQUMxQyxlQUFlLEtBQUssR0FBRztJQUN6QjtJQUNBLE1BQU0sY0FBYyxPQUFPO1FBQ3pCLE1BQU0sY0FBYztRQUNwQixNQUFNLGNBQWMsYUFBYSxJQUFJLEdBQUcsSUFBSTtRQUM1QyxJQUFJLENBQUMsYUFBYTtRQUNsQixJQUFJLE1BQU0sTUFBTSxhQUFhLENBQUMsYUFBYSxNQUFNLGNBQWMsR0FBRztZQUNoRSxlQUFlLEtBQUssR0FBRztRQUN6QjtJQUNGO0lBQ0EsTUFBTSxXQUFXLENBQUM7UUFDaEIsWUFBWSxLQUFLLEdBQUcsS0FBSyxHQUFHO1FBQzVC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