import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "@clank.run/framework";
/* @clankImportSource @clank.run/framework */ import { For, signal } from "@clank.run/framework";
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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vdmlldy50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsU0FBUyxPQUFPLFVBQVUsRUFBRSxZQUFZLGVBQWUsRUFBRSxjQUFjLGlCQUFpQixRQUFRLHVCQUF1QjtBQUN2SCwyQ0FBMkMsR0FDM0MsU0FBUyxHQUFHLEVBQUUsTUFBTSxRQUF5RCx1QkFBdUI7QUFHcEcsT0FBTyxTQUFTLGNBQWMsS0FnQjdCO0lBQ0MsTUFBTSxRQUFRLE9BQU87SUFDckIsTUFBTSxpQkFBaUIsT0FBTztJQUM5QixNQUFNLGVBQWUsT0FBTztJQUM1QixNQUFNLGNBQWMsT0FBMkI7SUFDL0MsTUFBTSxZQUFZLE9BQU87SUFDekIsTUFBTSxTQUFTLENBQUM7UUFDZCxNQUFNLGNBQWM7UUFDcEIsTUFBTSxRQUFRLE1BQU0sSUFBSSxHQUFHLElBQUk7UUFDL0IsSUFBSSxDQUFDLE9BQU87UUFDWixNQUFNLEdBQUcsQ0FBQztRQUNWLE1BQU0sS0FBSyxHQUFHO0lBQ2hCO0lBQ0EsTUFBTSxlQUFlLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLElBQUksTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRTtJQUM5RSxNQUFNLGNBQWM7UUFDbEIsYUFBYSxLQUFLLEdBQUcsTUFBTSxXQUFXLElBQUk7UUFDMUMsZUFBZSxLQUFLLEdBQUc7SUFDekI7SUFDQSxNQUFNLGNBQWMsT0FBTztRQUN6QixNQUFNLGNBQWM7UUFDcEIsTUFBTSxjQUFjLGFBQWEsSUFBSSxHQUFHLElBQUk7UUFDNUMsSUFBSSxDQUFDLGFBQWE7UUFDbEIsSUFBSSxNQUFNLE1BQU0sYUFBYSxDQUFDLGFBQWEsTUFBTSxjQUFjLEdBQUc7WUFDaEUsZUFBZSxLQUFLLEdBQUc7UUFDekI7SUFDRjtJQUNBLE1BQU0sV0FBVyxDQUFDO1FBQ2hCLFlBQVksS0FBSyxHQUFHLEtBQUssR0FBRztR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