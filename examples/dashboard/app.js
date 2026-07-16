import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "/dist/index.js";
import { For, Show, computed, createAgentSurface, createDialog, createForm, createPagination, createTabs, render, s, signal } from "/dist/index.js";
const names = [
    "Maya Chen",
    "Noah Williams",
    "Olivia Martin",
    "Liam Patel",
    "Ava Thompson",
    "Ethan Garcia",
    "Sophia Kim",
    "Lucas Brown",
    "Isabella Davis",
    "Mason Wilson",
    "Mia Anderson",
    "Elijah Moore",
    "Amelia Taylor",
    "James Jackson",
    "Harper White",
    "Benjamin Harris",
    "Evelyn Clark",
    "Henry Lewis",
    "Abigail Young",
    "Alexander Hall",
    "Emily Walker",
    "Daniel Allen",
    "Ella King",
    "Sebastian Wright"
];
const members = signal(names.map((name, index)=>({
        id: `member-${index + 1}`,
        name,
        email: `${name.toLowerCase().replace(" ", ".")}@relay.team`,
        role: index === 0 ? "Owner" : index % 5 === 0 ? "Admin" : index % 3 === 0 ? "Viewer" : "Editor",
        status: index % 11 === 0 ? "suspended" : index % 7 === 0 ? "invited" : "active",
        activity: index < 3 ? "Just now" : index < 9 ? `${index + 2} min ago` : `${index % 8 + 1} days ago`
    })));
const section = createTabs({
    id: "admin-sections",
    tabs: [
        {
            value: "overview"
        },
        {
            value: "people"
        },
        {
            value: "settings"
        }
    ]
});
const inviteDialog = createDialog({
    id: "invite-member"
});
const search = signal("");
const statusFilter = signal("all");
const savedSettings = signal(false);
const filteredMembers = computed(()=>{
    const term = search.value.trim().toLowerCase();
    return members.value.filter((member)=>(statusFilter.value === "all" || member.status === statusFilter.value) && (!term || `${member.name} ${member.email} ${member.role}`.toLowerCase().includes(term)));
});
const pagination = createPagination({
    total: computed(()=>filteredMembers.value.length),
    pageSize: 7
});
const visibleMembers = computed(()=>filteredMembers.value.slice(pagination.start.value - 1, pagination.end.value));
const invite = createForm({
    id: "invite",
    initial: {
        email: "",
        role: "Editor",
        sendCopy: true
    },
    schema: s.object({
        email: s.email({
            max: 160
        }),
        role: s.enum([
            "Owner",
            "Admin",
            "Editor",
            "Viewer"
        ]),
        sendCopy: s.boolean()
    }),
    validateOn: "blur",
    resetOnSuccess: true,
    onSubmit: async (values, { signal: abortSignal, setErrors })=>{
        if (members.peek().some((member)=>member.email === values.email.toLowerCase())) {
            setErrors({
                email: "That person already belongs to this workspace."
            });
            return;
        }
        await pause(350, abortSignal);
        const local = values.email.split("@")[0].replace(/[._-]+/g, " ");
        const name = local.replace(/\b\w/g, (letter)=>letter.toUpperCase());
        members.update((current)=>[
                {
                    id: crypto.randomUUID(),
                    name,
                    email: values.email.toLowerCase(),
                    role: values.role,
                    status: "invited",
                    activity: "Invitation sent"
                },
                ...current
            ]);
        inviteDialog.hide();
    }
});
const settings = createForm({
    id: "workspace-settings",
    initial: {
        workspace: "Relay Product Studio",
        seats: 30,
        digest: true,
        securityAlerts: true
    },
    schema: s.object({
        workspace: s.string({
            min: 2,
            max: 80
        }),
        seats: s.number({
            integer: true,
            min: 1,
            max: 500
        }),
        digest: s.boolean(),
        securityAlerts: s.boolean()
    }),
    validateOn: "blur",
    onSubmit: async (_values, { signal: abortSignal })=>{
        await pause(300, abortSignal);
        savedSettings.value = true;
        setTimeout(()=>{
            savedSettings.value = false;
        }, 2500);
    }
});
function pause(milliseconds, abortSignal) {
    return new Promise((resolve, reject)=>{
        const timer = setTimeout(resolve, milliseconds);
        abortSignal.addEventListener("abort", ()=>{
            clearTimeout(timer);
            reject(abortSignal.reason);
        }, {
            once: true
        });
    });
}
function FieldError({ field }) {
    return __clankJSX("p", {
        ...field.error(),
        "class": "mt-1 text-xs font-medium text-red-600"
    }, __clankExpression(()=>field.message.value));
}
function SideNavigation() {
    const links = [
        {
            value: "overview",
            label: "Overview",
            glyph: "⌁"
        },
        {
            value: "people",
            label: "People",
            glyph: "◎"
        },
        {
            value: "settings",
            label: "Settings",
            glyph: "⚙"
        }
    ];
    return __clankJSX("aside", {
        "class": "border-b border-white/10 bg-navy p-5 text-white lg:fixed lg:inset-y-0 lg:w-64 lg:border-b-0 lg:border-r"
    }, __clankJSX("div", {
        "class": "flex items-center justify-between lg:block"
    }, __clankJSX("div", {
        "class": "flex items-center gap-3"
    }, __clankJSX("div", {
        "class": "grid size-10 place-items-center rounded-xl bg-electric font-black"
    }, "R"), __clankJSX("div", {}, __clankJSX("strong", {
        "class": "block"
    }, "Relay"), __clankJSX("span", {
        "class": "text-xs text-white/50"
    }, "Product Studio"))), __clankJSX("span", {
        "class": "rounded-full bg-white/8 px-2.5 py-1 text-xs text-white/60"
    }, "PRO")), __clankJSX("nav", {
        ...section.list(),
        "class": "mt-0 grid grid-cols-3 gap-2 lg:mt-10 lg:block lg:space-y-2",
        "aria-label": "Admin sections"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>links),
        "by": "value"
    }, (link)=>__clankJSX("button", {
            ...section.tab(link.value),
            "class": "flex items-center justify-center gap-2 rounded-xl px-2 py-3 text-sm font-semibold text-white/60 transition hover:bg-white/8 hover:text-white lg:w-full lg:justify-start lg:gap-3 lg:px-4",
            "classList": __clankExpression(()=>({
                    "bg-white/10 text-white": section.selected.value === link.value
                })),
            "agentId": __clankExpression(()=>`nav-${link.value}`),
            "agentLabel": __clankExpression(()=>`Open ${link.label}`)
        }, __clankJSX("span", {
            "class": "text-lg"
        }, __clankExpression(()=>link.glyph)), __clankExpression(()=>link.label)))), __clankJSX("div", {
        "class": "mt-10 hidden rounded-2xl bg-white/6 p-4 lg:block"
    }, __clankJSX("p", {
        "class": "text-xs font-bold uppercase tracking-[.18em] text-white/40"
    }, "Monthly usage"), __clankJSX("div", {
        "class": "mt-3 h-2 overflow-hidden rounded-full bg-white/10"
    }, __clankJSX("div", {
        "class": "h-full w-[68%] rounded-full bg-electric"
    })), __clankJSX("p", {
        "class": "mt-2 text-xs text-white/50"
    }, "6,802 of 10,000 events")));
}
function MetricCard({ label, value, detail, tone }) {
    return __clankJSX("article", {
        "class": "rounded-2xl border border-black/6 bg-white p-5 shadow-sm"
    }, __clankJSX("div", {
        "class": __clankExpression(()=>`mb-5 size-2.5 rounded-full ${tone}`)
    }), __clankJSX("p", {
        "class": "text-sm text-black/50"
    }, __clankExpression(()=>label)), __clankJSX("strong", {
        "class": "mt-1 block text-3xl tracking-[-.04em]"
    }, __clankExpression(()=>value)), __clankJSX("p", {
        "class": "mt-3 text-xs font-medium text-emerald-600"
    }, __clankExpression(()=>detail)));
}
function Overview() {
    const activity = [
        [
            "MC",
            "Maya published “Summer launch”",
            "2 min"
        ],
        [
            "NW",
            "Noah invited 3 collaborators",
            "18 min"
        ],
        [
            "OM",
            "Olivia exported the July report",
            "1 hr"
        ],
        [
            "LP",
            "Liam changed workspace permissions",
            "3 hr"
        ]
    ];
    const bars = [
        44,
        62,
        48,
        78,
        66,
        91,
        84,
        58,
        72,
        88,
        76,
        96
    ];
    return __clankJSX("section", {
        ...section.panel("overview")
    }, __clankJSX("div", {
        "class": "grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
    }, __clankJSX(MetricCard, {
        "label": "Active projects",
        "value": "24",
        "detail": "↑ 12% this month",
        "tone": "bg-electric"
    }), __clankJSX(MetricCard, {
        "label": "Team members",
        "value": __clankExpression(()=>String(members.value.length)),
        "detail": "↑ 4 new invitations",
        "tone": "bg-emerald-500"
    }), __clankJSX(MetricCard, {
        "label": "Automations run",
        "value": "6,802",
        "detail": "↑ 18% from June",
        "tone": "bg-amber-400"
    }), __clankJSX(MetricCard, {
        "label": "Success rate",
        "value": "99.7%",
        "detail": "All systems healthy",
        "tone": "bg-sky-400"
    })), __clankJSX("div", {
        "class": "mt-5 grid gap-5 xl:grid-cols-[1.45fr_.75fr]"
    }, __clankJSX("article", {
        "class": "rounded-2xl border border-black/6 bg-white p-6 shadow-sm"
    }, __clankJSX("div", {
        "class": "flex items-start justify-between"
    }, __clankJSX("div", {}, __clankJSX("h2", {
        "class": "text-lg font-semibold"
    }, "Workspace activity"), __clankJSX("p", {
        "class": "mt-1 text-sm text-black/45"
    }, "Events completed over the last 12 weeks")), __clankJSX("span", {
        "class": "rounded-lg bg-lilac px-3 py-1.5 text-xs font-semibold text-electric"
    }, "Last 12 weeks")), __clankJSX("div", {
        "class": "mt-10 flex h-64 items-end gap-2",
        "aria-label": "Activity chart"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>bars)
    }, (height, index)=>__clankJSX("div", {
            "class": "flex-1 rounded-t-lg bg-electric/15 transition hover:bg-electric",
            "style": __clankExpression(()=>({
                    height: `${height}%`
                })),
            "title": __clankExpression(()=>`Week ${index() + 1}: ${height} events`)
        }))), __clankJSX("div", {
        "class": "mt-3 flex justify-between text-[10px] uppercase tracking-wider text-black/35"
    }, __clankJSX("span", {}, "May"), __clankJSX("span", {}, "June"), __clankJSX("span", {}, "July"))), __clankJSX("article", {
        "class": "rounded-2xl border border-black/6 bg-white p-6 shadow-sm"
    }, __clankJSX("h2", {
        "class": "text-lg font-semibold"
    }, "Recent activity"), __clankJSX("div", {
        "class": "mt-5 space-y-5"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>activity)
    }, (entry)=>__clankJSX("div", {
            "class": "flex gap-3"
        }, __clankJSX("div", {
            "class": "grid size-9 shrink-0 place-items-center rounded-full bg-lilac text-xs font-bold text-electric"
        }, __clankExpression(()=>entry[0])), __clankJSX("div", {
            "class": "min-w-0 flex-1"
        }, __clankJSX("p", {
            "class": "text-sm leading-5"
        }, __clankExpression(()=>entry[1])), __clankJSX("span", {
            "class": "text-xs text-black/40"
        }, __clankExpression(()=>entry[2]), " ago"))))))));
}
function StatusBadge({ status }) {
    const styles = status === "active" ? "bg-emerald-50 text-emerald-700" : status === "invited" ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700";
    return __clankJSX("span", {
        "class": __clankExpression(()=>`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${styles}`)
    }, __clankExpression(()=>status));
}
function People() {
    return __clankJSX("section", {
        ...section.panel("people")
    }, __clankJSX("div", {
        "class": "rounded-2xl border border-black/6 bg-white shadow-sm"
    }, __clankJSX("div", {
        "class": "flex flex-col gap-4 border-b border-black/6 p-5 lg:flex-row lg:items-center"
    }, __clankJSX("div", {
        "class": "flex-1"
    }, __clankJSX("h2", {
        "class": "text-lg font-semibold"
    }, "People"), __clankJSX("p", {
        "class": "text-sm text-black/45"
    }, "Manage access, roles, and invitations.")), __clankJSX("input", {
        "class": "rounded-xl border border-black/10 px-4 py-2.5 text-sm",
        "placeholder": "Search people…",
        "bind:value": search,
        "id": "member-search",
        "name": "search"
    }), __clankJSX("select", {
        "class": "rounded-xl border border-black/10 bg-white px-4 py-2.5 text-sm",
        "bind:value": statusFilter,
        "id": "status-filter",
        "aria-label": "Filter member status"
    }, __clankJSX("option", {
        "value": "all"
    }, "All statuses"), __clankJSX("option", {
        "value": "active"
    }, "Active"), __clankJSX("option", {
        "value": "invited"
    }, "Invited"), __clankJSX("option", {
        "value": "suspended"
    }, "Suspended")), __clankJSX("button", {
        ...inviteDialog.trigger({
            agentId: "invite-member",
            agentLabel: "Invite a team member"
        }),
        "class": "rounded-xl bg-electric px-4 py-2.5 text-sm font-semibold text-white"
    }, "Invite member")), __clankJSX("div", {
        "class": "overflow-x-auto"
    }, __clankJSX("table", {
        "class": "w-full min-w-[720px] text-left text-sm"
    }, __clankJSX("thead", {
        "class": "bg-cloud text-xs uppercase tracking-wider text-black/40"
    }, __clankJSX("tr", {}, __clankJSX("th", {
        "class": "px-5 py-3"
    }, "Member"), __clankJSX("th", {
        "class": "px-5 py-3"
    }, "Role"), __clankJSX("th", {
        "class": "px-5 py-3"
    }, "Status"), __clankJSX("th", {
        "class": "px-5 py-3"
    }, "Last activity"), __clankJSX("th", {
        "class": "px-5 py-3"
    }, __clankJSX("span", {
        "class": "sr-only"
    }, "Actions")))), __clankJSX("tbody", {
        "class": "divide-y divide-black/6"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>visibleMembers.value),
        "by": "id",
        "fallback": __clankJSX("tr", {}, __clankJSX("td", {
            "colspan": 5,
            "class": "p-12 text-center text-black/45"
        }, "No people match those filters."))
    }, (member)=>__clankJSX("tr", {}, __clankJSX("td", {
            "class": "px-5 py-4"
        }, __clankJSX("div", {
            "class": "font-semibold"
        }, __clankExpression(()=>member.name)), __clankJSX("div", {
            "class": "text-xs text-black/45"
        }, __clankExpression(()=>member.email))), __clankJSX("td", {
            "class": "px-5 py-4"
        }, __clankExpression(()=>member.role)), __clankJSX("td", {
            "class": "px-5 py-4"
        }, __clankJSX(StatusBadge, {
            "status": __clankExpression(()=>member.status)
        })), __clankJSX("td", {
            "class": "px-5 py-4 text-black/50"
        }, __clankExpression(()=>member.activity)), __clankJSX("td", {
            "class": "px-5 py-4 text-right"
        }, __clankJSX("button", {
            "class": "rounded-lg px-3 py-1.5 text-black/45 hover:bg-cloud hover:text-navy",
            "agentId": __clankExpression(()=>`member-${member.id}-menu`),
            "agentLabel": __clankExpression(()=>`Open actions for ${member.name}`)
        }, "•••"))))))), __clankJSX("footer", {
        "class": "flex flex-col gap-3 border-t border-black/6 p-4 sm:flex-row sm:items-center sm:justify-between"
    }, __clankJSX("p", {
        "class": "text-xs text-black/45"
    }, "Showing ", __clankExpression(()=>pagination.start.value), "–", __clankExpression(()=>pagination.end.value), " of ", __clankExpression(()=>pagination.total.value)), __clankJSX("nav", {
        "class": "flex items-center gap-1",
        "aria-label": "Member pages"
    }, __clankJSX("button", {
        "class": "rounded-lg px-3 py-2 text-sm disabled:opacity-30",
        "disabled": __clankExpression(()=>!pagination.canPrevious.value),
        "onClick": pagination.previous
    }, "Previous"), __clankJSX(For, {
        "each": __clankExpression(()=>pagination.pages.value)
    }, (page)=>page === "ellipsis" ? __clankJSX("span", {
            "class": "px-2 text-black/35"
        }, "…") : __clankJSX("button", {
            "class": "grid size-9 place-items-center rounded-lg text-sm",
            "classList": __clankExpression(()=>({
                    "bg-navy text-white": pagination.page.value === page
                })),
            "onClick": ()=>pagination.setPage(page)
        }, __clankExpression(()=>page))), __clankJSX("button", {
        "class": "rounded-lg px-3 py-2 text-sm disabled:opacity-30",
        "disabled": __clankExpression(()=>!pagination.canNext.value),
        "onClick": pagination.next
    }, "Next")))));
}
function Settings() {
    const workspace = settings.field("workspace");
    const seats = settings.field("seats");
    const digest = settings.field("digest");
    const securityAlerts = settings.field("securityAlerts");
    return __clankJSX("section", {
        ...section.panel("settings"),
        "class": "max-w-3xl"
    }, __clankJSX("form", {
        ...settings.props(),
        "class": "rounded-2xl border border-black/6 bg-white shadow-sm"
    }, __clankJSX("div", {
        "class": "border-b border-black/6 p-6"
    }, __clankJSX("h2", {
        "class": "text-lg font-semibold"
    }, "Workspace settings"), __clankJSX("p", {
        "class": "mt-1 text-sm text-black/45"
    }, "General details and notification preferences.")), __clankJSX("div", {
        "class": "space-y-6 p-6"
    }, __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>workspace.id)
    }, "Workspace name"), __clankJSX("input", {
        ...workspace.input(),
        "class": "mt-2 w-full rounded-xl border border-black/10 px-4 py-3"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>workspace)
    })), __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>seats.id)
    }, "Seat limit"), __clankJSX("input", {
        ...seats.input({
            type: "number"
        }),
        "min": 1,
        "max": 500,
        "class": "mt-2 w-full rounded-xl border border-black/10 px-4 py-3"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>seats)
    })), __clankJSX("div", {
        "class": "space-y-3 border-t border-black/6 pt-6"
    }, __clankJSX("label", {
        "class": "flex items-center justify-between gap-5 rounded-xl bg-cloud p-4"
    }, __clankJSX("span", {}, __clankJSX("strong", {
        "class": "block text-sm"
    }, "Weekly digest"), __clankJSX("span", {
        "class": "text-xs text-black/45"
    }, "A concise workspace summary each Monday.")), __clankJSX("input", {
        ...digest.checkbox(),
        "class": "size-5 accent-electric"
    })), __clankJSX("label", {
        "class": "flex items-center justify-between gap-5 rounded-xl bg-cloud p-4"
    }, __clankJSX("span", {}, __clankJSX("strong", {
        "class": "block text-sm"
    }, "Security alerts"), __clankJSX("span", {
        "class": "text-xs text-black/45"
    }, "Important access and permission changes.")), __clankJSX("input", {
        ...securityAlerts.checkbox(),
        "class": "size-5 accent-electric"
    })))), __clankJSX("footer", {
        "class": "flex items-center justify-end gap-4 border-t border-black/6 p-5"
    }, __clankJSX("span", {
        "class": "text-sm font-medium text-emerald-600",
        "hidden": ()=>!savedSettings.value
    }, "Settings saved."), __clankJSX("button", {
        "class": "rounded-xl bg-navy px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50",
        "type": "submit",
        "disabled": __clankExpression(()=>settings.pending.value || !settings.dirty.value)
    }, __clankExpression(()=>settings.pending.value ? "Saving…" : "Save changes")))));
}
function InviteDialog() {
    const email = invite.field("email");
    const role = invite.field("role");
    const sendCopy = invite.field("sendCopy");
    return __clankJSX(__clankFragment, {}, __clankJSX("div", {
        ...inviteDialog.backdrop(),
        "class": "fixed inset-0 z-40 bg-navy/40 backdrop-blur-sm"
    }), __clankJSX("section", {
        ...inviteDialog.dialog(),
        "class": "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-7 shadow-2xl"
    }, __clankJSX("div", {
        "class": "flex items-start justify-between gap-5"
    }, __clankJSX("div", {}, __clankJSX("h2", {
        ...inviteDialog.title(),
        "class": "text-2xl font-semibold"
    }, "Invite a teammate"), __clankJSX("p", {
        ...inviteDialog.description(),
        "class": "mt-2 text-sm text-black/50"
    }, "They’ll receive a secure link to join Relay Product Studio.")), __clankJSX("button", {
        "class": "grid size-10 place-items-center rounded-full bg-cloud text-xl",
        "onClick": inviteDialog.hide,
        "agentLabel": "Close invite dialog"
    }, "×")), __clankJSX("form", {
        ...invite.props(),
        "class": "mt-7 space-y-5"
    }, __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>email.id)
    }, "Work email"), __clankJSX("input", {
        ...email.input({
            type: "email"
        }),
        "autocomplete": "email",
        "class": "mt-2 w-full rounded-xl border border-black/10 px-4 py-3 focus:border-electric"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>email)
    })), __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>role.id)
    }, "Role"), __clankJSX("select", {
        ...role.select(),
        "class": "mt-2 w-full rounded-xl border border-black/10 bg-white px-4 py-3"
    }, __clankJSX("option", {}, "Admin"), __clankJSX("option", {}, "Editor"), __clankJSX("option", {}, "Viewer")), __clankJSX(FieldError, {
        "field": __clankExpression(()=>role)
    })), __clankJSX("label", {
        "class": "flex items-center gap-3 text-sm"
    }, __clankJSX("input", {
        ...sendCopy.checkbox(),
        "class": "size-4 accent-electric"
    }), "Send me a copy of the invitation"), __clankJSX("button", {
        "class": "w-full rounded-xl bg-electric px-5 py-3 font-semibold text-white disabled:opacity-50",
        "disabled": __clankExpression(()=>invite.pending.value),
        "type": "submit",
        "agentId": "send-invitation",
        "agentAction": "members.invite"
    }, __clankExpression(()=>invite.pending.value ? "Sending invitation…" : "Send invitation")))));
}
function App() {
    return __clankJSX("div", {
        "class": "min-h-screen"
    }, __clankJSX(SideNavigation, {}), __clankJSX("main", {
        "class": "lg:ml-64"
    }, __clankJSX("header", {
        "class": "flex items-center justify-between border-b border-black/6 bg-white px-5 py-5 sm:px-8"
    }, __clankJSX("div", {}, __clankJSX("p", {
        "class": "text-xs font-bold uppercase tracking-[.18em] text-electric"
    }, "Workspace"), __clankJSX("h1", {
        "class": "mt-1 text-2xl font-semibold capitalize"
    }, __clankExpression(()=>section.selected.value))), __clankJSX("div", {
        "class": "flex items-center gap-3"
    }, __clankJSX("button", {
        "class": "grid size-10 place-items-center rounded-full bg-cloud",
        "aria-label": "Notifications"
    }, "◌"), __clankJSX("div", {
        "class": "grid size-10 place-items-center rounded-full bg-navy text-xs font-bold text-white"
    }, "MC"))), __clankJSX("div", {
        "class": "p-5 sm:p-8"
    }, __clankJSX(Overview, {}), __clankJSX(People, {}), __clankJSX(Settings, {}))), __clankJSX(InviteDialog, {}));
}
render(document.querySelector("#app"), __clankJSX(App, {}));
Object.assign(globalThis, {
    dashboard: {
        members,
        invite,
        settings,
        pagination,
        surface: createAgentSurface(document.querySelector("#app"))
    }
});


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9kYXNoYm9hcmQvYXBwLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLE9BQU8sVUFBVSxFQUFFLFlBQVksZUFBZSxFQUFFLGNBQWMsaUJBQWlCLFFBQVEsaUJBQWlCO0FBQ2pILFNBQ0UsR0FBRyxFQUNILElBQUksRUFDSixRQUFRLEVBQ1Isa0JBQWtCLEVBQ2xCLFlBQVksRUFDWixVQUFVLEVBQ1YsZ0JBQWdCLEVBQ2hCLFVBQVUsRUFDVixNQUFNLEVBQ04sQ0FBQyxFQUNELE1BQU0sUUFFRCxpQkFBaUI7QUFheEIsTUFBTSxRQUFRO0lBQ1o7SUFBYTtJQUFpQjtJQUFpQjtJQUFjO0lBQWdCO0lBQzdFO0lBQWM7SUFBZTtJQUFrQjtJQUFnQjtJQUFnQjtJQUMvRTtJQUFpQjtJQUFpQjtJQUFnQjtJQUFtQjtJQUFnQjtJQUNyRjtJQUFpQjtJQUFrQjtJQUFnQjtJQUFnQjtJQUFhO0NBQ2pGO0FBQ0QsTUFBTSxVQUFVLE9BQWlCLE1BQU0sR0FBRyxDQUFDLENBQUMsTUFBTSxRQUFVLENBQUM7UUFDM0QsSUFBSSxDQUFDLE9BQU8sRUFBRSxRQUFRLEdBQUc7UUFDekI7UUFDQSxPQUFPLEdBQUcsS0FBSyxXQUFXLEdBQUcsT0FBTyxDQUFDLEtBQUssS0FBSyxXQUFXLENBQUM7UUFDM0QsTUFBTSxVQUFVLElBQUksVUFBVSxRQUFRLE1BQU0sSUFBSSxVQUFVLFFBQVEsTUFBTSxJQUFJLFdBQVc7UUFDdkYsUUFBUSxRQUFRLE9BQU8sSUFBSSxjQUFjLFFBQVEsTUFBTSxJQUFJLFlBQVk7UUFDdkUsVUFBVSxRQUFRLElBQUksYUFBYSxRQUFRLElBQUksR0FBRyxRQUFRLEVBQUUsUUFBUSxDQUFDLEdBQUcsR0FBRyxBQUFDLFFBQVEsSUFBSyxFQUFFLFNBQVMsQ0FBQztJQUN2RyxDQUFDO0FBRUQsTUFBTSxVQUFVLFdBQVc7SUFDekIsSUFBSTtJQUNKLE1BQU07UUFBQztZQUFFLE9B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