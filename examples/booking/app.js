import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "/dist/index.js";
import { For, Show, computed, createAgentSurface, createDisclosure, createForm, render, s, signal } from "/dist/index.js";
const rooms = [
    {
        id: "courtyard",
        name: "Courtyard Room",
        description: "Quiet, tactile, and filled with soft morning light.",
        price: 188,
        size: "28 m²",
        tone: "from-amber-100 to-orange-300",
        features: [
            "Queen bed",
            "Garden outlook",
            "Rain shower"
        ]
    },
    {
        id: "skyline",
        name: "Skyline Studio",
        description: "A generous corner studio above the neighborhood rooftops.",
        price: 264,
        size: "39 m²",
        tone: "from-sky-200 to-blue-500",
        features: [
            "King bed",
            "City view",
            "Reading lounge"
        ]
    },
    {
        id: "suite",
        name: "Terrace Suite",
        description: "Separate living space and a private terrace for slow evenings.",
        price: 376,
        size: "58 m²",
        tone: "from-emerald-200 to-teal-600",
        features: [
            "King bed",
            "Private terrace",
            "Soaking tub"
        ]
    }
];
const step = signal(1);
const selectedRoom = signal("skyline");
const confirmation = signal("");
const details = createDisclosure({
    id: "booking-details",
    initialOpen: true
});
const search = createForm({
    id: "stay-search",
    initial: {
        destination: "Lisbon",
        checkIn: "2026-09-18",
        checkOut: "2026-09-22",
        guests: 2
    },
    schema: s.object({
        destination: s.enum([
            "Lisbon",
            "Kyoto",
            "Mexico City"
        ]),
        checkIn: s.date(),
        checkOut: s.date(),
        guests: s.number({
            integer: true,
            min: 1,
            max: 6
        })
    }),
    validateOn: "blur",
    validate (values) {
        return values.checkOut <= values.checkIn ? {
            checkOut: "Check-out must be after check-in."
        } : undefined;
    }
});
const guest = createForm({
    id: "guest-details",
    initial: {
        firstName: "",
        lastName: "",
        email: "",
        requests: "",
        accepted: false
    },
    schema: s.object({
        firstName: s.string({
            min: 2,
            max: 60
        }),
        lastName: s.string({
            min: 2,
            max: 60
        }),
        email: s.email({
            max: 160
        }),
        requests: s.string({
            max: 500
        }),
        accepted: s.literal(true)
    }),
    validateOn: "blur",
    onSubmit: async (_values, { signal: abortSignal })=>{
        await pause(650, abortSignal);
        confirmation.value = `EW-${Math.floor(100000 + Math.random() * 900000)}`;
        step.value = 4;
        return confirmation.value;
    }
});
const nights = computed(()=>{
    const values = search.values.value;
    const milliseconds = Date.parse(`${values.checkOut}T00:00:00Z`) - Date.parse(`${values.checkIn}T00:00:00Z`);
    return Math.max(1, Math.round(milliseconds / 86_400_000));
});
const room = computed(()=>rooms.find((entry)=>entry.id === selectedRoom.value));
const subtotal = computed(()=>room.value.price * nights.value);
const service = computed(()=>Math.round(subtotal.value * 0.12));
const total = computed(()=>subtotal.value + service.value);
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
function money(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
    }).format(value);
}
function readableDate(value) {
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC"
    }).format(new Date(`${value}T00:00:00Z`));
}
function FieldError({ field }) {
    return __clankJSX("p", {
        ...field.error(),
        "class": "mt-1 text-xs font-semibold text-red-700"
    }, __clankExpression(()=>field.message.value));
}
function Progress() {
    const steps = [
        "Stay",
        "Room",
        "Details",
        "Confirmed"
    ];
    return __clankJSX("ol", {
        "class": "grid grid-cols-4 gap-2",
        "aria-label": "Booking progress"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>steps)
    }, (label, index)=>{
        const number = index() + 1;
        return __clankJSX("li", {
            "class": "flex items-center gap-2"
        }, __clankJSX("span", {
            "class": "grid size-8 shrink-0 place-items-center rounded-full border border-night/15 text-xs font-bold",
            "classList": __clankExpression(()=>({
                    "border-ocean bg-ocean text-white": step.value >= number
                })),
            "aria-current": __clankExpression(()=>step.value === number ? "step" : undefined)
        }, __clankExpression(()=>step.value > number ? "✓" : number)), __clankJSX("span", {
            "class": "hidden text-xs font-semibold sm:block",
            "classList": __clankExpression(()=>({
                    "text-ocean": step.value === number,
                    "text-night/40": step.value !== number
                }))
        }, __clankExpression(()=>label)));
    }));
}
function SearchStep() {
    const destination = search.field("destination");
    const checkIn = search.field("checkIn");
    const checkOut = search.field("checkOut");
    const guests = search.field("guests");
    const next = (event)=>{
        event.preventDefault();
        if (search.validate("submit")) step.value = 2;
        else search.focusFirstError();
    };
    return __clankJSX("section", {
        "hidden": ()=>step.value !== 1
    }, __clankJSX("p", {
        "class": "text-xs font-black uppercase tracking-[.22em] text-ocean"
    }, "Find your stay"), __clankJSX("h1", {
        "class": "mt-3 text-4xl font-semibold tracking-[-.04em] sm:text-5xl"
    }, "Where should we wake up?"), __clankJSX("p", {
        "class": "mt-4 max-w-xl leading-7 text-night/55"
    }, "Thoughtful neighborhood hotels, selected for design, hospitality, and a real sense of place."), __clankJSX("form", {
        "class": "mt-9 grid gap-5",
        "onSubmit": next,
        "noValidate": true
    }, __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>destination.id)
    }, "Destination"), __clankJSX("select", {
        ...destination.select(),
        "class": "mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5"
    }, __clankJSX("option", {}, "Lisbon"), __clankJSX("option", {}, "Kyoto"), __clankJSX("option", {}, "Mexico City")), __clankJSX(FieldError, {
        "field": __clankExpression(()=>destination)
    })), __clankJSX("div", {
        "class": "grid gap-5 sm:grid-cols-2"
    }, __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>checkIn.id)
    }, "Check-in"), __clankJSX("input", {
        ...checkIn.input({
            type: "date"
        }),
        "class": "mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>checkIn)
    })), __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>checkOut.id)
    }, "Check-out"), __clankJSX("input", {
        ...checkOut.input({
            type: "date"
        }),
        "class": "mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>checkOut)
    }))), __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>guests.id)
    }, "Guests"), __clankJSX("input", {
        ...guests.input({
            type: "number"
        }),
        "min": 1,
        "max": 6,
        "class": "mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>guests)
    })), __clankJSX("button", {
        "class": "mt-2 rounded-full bg-night px-6 py-4 font-bold text-white hover:bg-ocean",
        "type": "submit",
        "agentId": "search-stays",
        "agentAction": "booking.search"
    }, "See available rooms")));
}
function RoomStep() {
    return __clankJSX("section", {
        "hidden": ()=>step.value !== 2
    }, __clankJSX("p", {
        "class": "text-xs font-black uppercase tracking-[.22em] text-ocean"
    }, "Choose a room"), __clankJSX("h1", {
        "class": "mt-3 text-4xl font-semibold tracking-[-.04em]"
    }, "A good place to land."), __clankJSX("p", {
        "class": "mt-3 text-night/50"
    }, __clankExpression(()=>readableDate(search.values.value.checkIn)), " – ", __clankExpression(()=>readableDate(search.values.value.checkOut)), " · ", __clankExpression(()=>search.values.value.guests), " guests"), __clankJSX("div", {
        "class": "mt-8 space-y-4",
        "role": "radiogroup",
        "aria-label": "Available rooms"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>rooms),
        "by": "id"
    }, (option)=>__clankJSX("label", {
            "class": "grid cursor-pointer gap-5 rounded-3xl border border-night/10 bg-white p-4 transition hover:border-ocean sm:grid-cols-[9rem_1fr_auto]",
            "classList": __clankExpression(()=>({
                    "border-ocean ring-2 ring-ocean/15": selectedRoom.value === option.id
                }))
        }, __clankJSX("div", {
            "class": __clankExpression(()=>`min-h-32 rounded-2xl bg-gradient-to-br ${option.tone}`)
        }), __clankJSX("div", {
            "class": "self-center"
        }, __clankJSX("div", {
            "class": "flex items-center gap-3"
        }, __clankJSX("h2", {
            "class": "text-xl font-semibold"
        }, __clankExpression(()=>option.name)), __clankJSX("span", {
            "class": "text-xs text-night/40"
        }, __clankExpression(()=>option.size))), __clankJSX("p", {
            "class": "mt-2 text-sm leading-6 text-night/50"
        }, __clankExpression(()=>option.description)), __clankJSX("p", {
            "class": "mt-3 text-xs font-semibold text-ocean"
        }, __clankExpression(()=>option.features.join(" · ")))), __clankJSX("div", {
            "class": "flex items-center justify-between gap-4 sm:block sm:text-right"
        }, __clankJSX("input", {
            "type": "radio",
            "name": "room",
            "value": __clankExpression(()=>option.id),
            "checked": __clankExpression(()=>selectedRoom.value === option.id),
            "onChange": ()=>{
                selectedRoom.value = option.id;
            },
            "class": "size-5 accent-ocean",
            "agentId": __clankExpression(()=>`room-${option.id}`),
            "agentLabel": __clankExpression(()=>`Select ${option.name}`)
        }), __clankJSX("p", {
            "class": "sm:mt-7"
        }, __clankJSX("strong", {
            "class": "text-xl"
        }, __clankExpression(()=>money(option.price))), __clankJSX("span", {
            "class": "block text-xs text-night/40"
        }, "per night")))))), __clankJSX("div", {
        "class": "mt-8 flex justify-between gap-4"
    }, __clankJSX("button", {
        "class": "rounded-full border border-night/15 px-6 py-3 font-semibold",
        "onClick": ()=>{
            step.value = 1;
        }
    }, "Back"), __clankJSX("button", {
        "class": "rounded-full bg-night px-6 py-3 font-bold text-white",
        "onClick": ()=>{
            step.value = 3;
        },
        "agentId": "continue-to-details"
    }, "Continue")));
}
function GuestStep() {
    const firstName = guest.field("firstName");
    const lastName = guest.field("lastName");
    const email = guest.field("email");
    const requests = guest.field("requests");
    const accepted = guest.field("accepted");
    return __clankJSX("section", {
        "hidden": ()=>step.value !== 3
    }, __clankJSX("p", {
        "class": "text-xs font-black uppercase tracking-[.22em] text-ocean"
    }, "Almost there"), __clankJSX("h1", {
        "class": "mt-3 text-4xl font-semibold tracking-[-.04em]"
    }, "Who are we welcoming?"), __clankJSX("form", {
        ...guest.props(),
        "class": "mt-8 grid gap-5"
    }, __clankJSX("div", {
        "class": "grid gap-5 sm:grid-cols-2"
    }, __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>firstName.id)
    }, "First name"), __clankJSX("input", {
        ...firstName.input(),
        "autocomplete": "given-name",
        "class": "mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>firstName)
    })), __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>lastName.id)
    }, "Last name"), __clankJSX("input", {
        ...lastName.input(),
        "autocomplete": "family-name",
        "class": "mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>lastName)
    }))), __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>email.id)
    }, "Email"), __clankJSX("input", {
        ...email.input({
            type: "email"
        }),
        "autocomplete": "email",
        "class": "mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>email)
    })), __clankJSX("div", {}, __clankJSX("label", {
        "class": "text-sm font-semibold",
        "for": __clankExpression(()=>requests.id)
    }, "Special requests ", __clankJSX("span", {
        "class": "font-normal text-night/40"
    }, "(optional)")), __clankJSX("textarea", {
        ...requests.textarea(),
        "rows": 4,
        "class": "mt-2 w-full resize-none rounded-2xl border border-night/12 bg-white px-4 py-3.5"
    }), __clankJSX(FieldError, {
        "field": __clankExpression(()=>requests)
    })), __clankJSX("label", {
        "class": "flex items-start gap-3 rounded-2xl bg-skywash p-4 text-sm leading-6"
    }, __clankJSX("input", {
        ...accepted.checkbox(),
        "class": "mt-1 size-4 accent-ocean"
    }), __clankJSX("span", {}, "I agree to the booking terms and cancellation policy.")), __clankJSX(FieldError, {
        "field": __clankExpression(()=>accepted)
    }), __clankJSX("div", {
        "class": "mt-2 flex justify-between gap-4"
    }, __clankJSX("button", {
        "class": "rounded-full border border-night/15 px-6 py-3 font-semibold",
        "type": "button",
        "onClick": ()=>{
            step.value = 2;
        }
    }, "Back"), __clankJSX("button", {
        "class": "rounded-full bg-coral px-7 py-3 font-bold text-night disabled:opacity-50",
        "type": "submit",
        "disabled": __clankExpression(()=>guest.pending.value),
        "agentId": "confirm-booking",
        "agentAction": "booking.confirm"
    }, __clankExpression(()=>guest.pending.value ? "Confirming…" : `Confirm · ${money(total.value)}`)))));
}
function ConfirmationStep() {
    return __clankJSX("section", {
        "hidden": ()=>step.value !== 4,
        "class": "py-8 text-center"
    }, __clankJSX("div", {
        "class": "mx-auto grid size-20 place-items-center rounded-full bg-ocean text-4xl text-white"
    }, "✓"), __clankJSX("p", {
        "class": "mt-7 text-xs font-black uppercase tracking-[.22em] text-ocean"
    }, "You’re going to ", __clankExpression(()=>search.values.value.destination)), __clankJSX("h1", {
        "class": "mt-3 text-4xl font-semibold tracking-[-.04em] sm:text-5xl"
    }, "Your room is waiting."), __clankJSX("p", {
        "class": "mx-auto mt-4 max-w-lg leading-7 text-night/55"
    }, "We sent the complete itinerary and flexible cancellation details to ", __clankExpression(()=>guest.values.value.email), "."), __clankJSX("div", {
        "class": "mx-auto mt-8 max-w-md rounded-3xl bg-white p-6 text-left shadow-sm"
    }, __clankJSX("div", {
        "class": "flex justify-between"
    }, __clankJSX("span", {
        "class": "text-night/45"
    }, "Confirmation"), __clankJSX("strong", {}, __clankExpression(()=>confirmation.value))), __clankJSX("div", {
        "class": "mt-3 flex justify-between"
    }, __clankJSX("span", {
        "class": "text-night/45"
    }, "Stay"), __clankJSX("strong", {}, __clankExpression(()=>nights.value), " nights · ", __clankExpression(()=>room.value.name))), __clankJSX("div", {
        "class": "mt-3 flex justify-between"
    }, __clankJSX("span", {
        "class": "text-night/45"
    }, "Total"), __clankJSX("strong", {}, __clankExpression(()=>money(total.value))))), __clankJSX("button", {
        "class": "mt-8 rounded-full bg-night px-7 py-3 font-semibold text-white",
        "onClick": ()=>{
            confirmation.value = "";
            guest.reset();
            step.value = 1;
        }
    }, "Plan another stay"));
}
function BookingSummary() {
    return __clankJSX("aside", {
        "class": "rounded-[2rem] bg-night p-6 text-white lg:sticky lg:top-8 lg:self-start"
    }, __clankJSX("button", {
        ...details.trigger({
            agentId: "toggle-booking-summary",
            agentLabel: "Toggle booking summary"
        }),
        "class": "flex w-full items-center justify-between text-left"
    }, __clankJSX("span", {}, __clankJSX("span", {
        "class": "block text-xs font-bold uppercase tracking-[.18em] text-white/45"
    }, "Your stay"), __clankJSX("strong", {
        "class": "mt-1 block text-xl"
    }, __clankExpression(()=>search.values.value.destination))), __clankJSX("span", {
        "class": "text-xl"
    }, __clankExpression(()=>details.open.value ? "−" : "+"))), __clankJSX("div", {
        ...details.panel({
            role: "region"
        }),
        "class": "mt-6"
    }, __clankJSX("div", {
        "class": __clankExpression(()=>`aspect-[4/3] rounded-2xl bg-gradient-to-br ${room.value.tone}`)
    }), __clankJSX("h2", {
        "class": "mt-5 text-lg font-semibold"
    }, __clankExpression(()=>room.value.name)), __clankJSX("p", {
        "class": "mt-1 text-sm text-white/50"
    }, __clankExpression(()=>readableDate(search.values.value.checkIn)), " – ", __clankExpression(()=>readableDate(search.values.value.checkOut))), __clankJSX("dl", {
        "class": "mt-6 space-y-3 border-t border-white/10 pt-5 text-sm"
    }, __clankJSX("div", {
        "class": "flex justify-between"
    }, __clankJSX("dt", {
        "class": "text-white/50"
    }, __clankExpression(()=>money(room.value.price)), " × ", __clankExpression(()=>nights.value), " nights"), __clankJSX("dd", {}, __clankExpression(()=>money(subtotal.value)))), __clankJSX("div", {
        "class": "flex justify-between"
    }, __clankJSX("dt", {
        "class": "text-white/50"
    }, "Service & local taxes"), __clankJSX("dd", {}, __clankExpression(()=>money(service.value)))), __clankJSX("div", {
        "class": "flex justify-between border-t border-white/10 pt-4 text-base font-bold"
    }, __clankJSX("dt", {}, "Total"), __clankJSX("dd", {}, __clankExpression(()=>money(total.value))))), __clankJSX("p", {
        "class": "mt-5 rounded-xl bg-white/6 p-3 text-xs leading-5 text-white/55"
    }, "Free cancellation until 48 hours before check-in.")));
}
function App() {
    return __clankJSX("div", {
        "class": "min-h-screen"
    }, __clankJSX("header", {
        "class": "border-b border-night/8 bg-sand/90 backdrop-blur"
    }, __clankJSX("div", {
        "class": "mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-5 sm:px-8"
    }, __clankJSX("a", {
        "href": "#",
        "class": "text-xl font-black tracking-[-.04em]"
    }, "ELSE", __clankJSX("span", {
        "class": "text-ocean"
    }, "WHERE")), __clankJSX("span", {
        "class": "text-right text-[10px] font-semibold leading-4 text-night/45 sm:text-xs"
    }, "Secure booking ", __clankJSX("span", {
        "class": "hidden sm:inline"
    }, "· No account required")))), __clankJSX("main", {
        "class": "mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:py-12"
    }, __clankJSX(Progress, {}), __clankJSX("div", {
        "class": "mt-10 grid gap-10 lg:grid-cols-[1fr_22rem]"
    }, __clankJSX("div", {
        "class": "min-w-0"
    }, __clankJSX(SearchStep, {}), __clankJSX(RoomStep, {}), __clankJSX(GuestStep, {}), __clankJSX(ConfirmationStep, {})), __clankJSX(BookingSummary, {}))));
}
render(document.querySelector("#app"), __clankJSX(App, {}));
Object.assign(globalThis, {
    booking: {
        step,
        search,
        guest,
        selectedRoom,
        surface: createAgentSurface(document.querySelector("#app"))
    }
});


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9ib29raW5nL2FwcC50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsU0FBUyxPQUFPLFVBQVUsRUFBRSxZQUFZLGVBQWUsRUFBRSxjQUFjLGlCQUFpQixRQUFRLGlCQUFpQjtBQUNqSCxTQUNFLEdBQUcsRUFDSCxJQUFJLEVBQ0osUUFBUSxFQUNSLGtCQUFrQixFQUNsQixnQkFBZ0IsRUFDaEIsVUFBVSxFQUNWLE1BQU0sRUFDTixDQUFDLEVBQ0QsTUFBTSxRQUVELGlCQUFpQjtBQWV4QixNQUFNLFFBQWdCO0lBQ3BCO1FBQUUsSUFBSTtRQUFhLE1BQU07UUFBa0IsYUFBYTtRQUF1RCxPQUFPO1FBQUssTUFBTTtRQUFTLE1BQU07UUFBZ0MsVUFBVTtZQUFDO1lBQWE7WUFBa0I7U0FBYztJQUFDO0lBQ3pPO1FBQUUsSUFBSTtRQUFXLE1BQU07UUFBa0IsYUFBYTtRQUE2RCxPQUFPO1FBQUssTUFBTTtRQUFTLE1BQU07UUFBNEIsVUFBVTtZQUFDO1lBQVk7WUFBYTtTQUFpQjtJQUFDO0lBQ3RPO1FBQUUsSUFBSTtRQUFTLE1BQU07UUFBaUIsYUFBYTtRQUFrRSxPQUFPO1FBQUssTUFBTTtRQUFTLE1BQU07UUFBZ0MsVUFBVTtZQUFDO1lBQVk7WUFBbUI7U0FBYztJQUFDO0NBQ2hQO0FBRUQsTUFBTSxPQUFPLE9BQXNCO0FBQ25DLE1BQU0sZUFBZSxPQUFlO0FBQ3BDLE1BQU0sZUFBZSxPQUFPO0FBQzVCLE1BQU0sVUFBVSxpQkFBaUI7SUFBRSxJQUFJO0lBQW1CLGFBQWE7QUFBSztBQUU1RSxNQUFNLFNBQVMsV0FBVztJQUN4QixJQUFJO0lBQ0osU0FBUztRQUNQLGFBQWE7UUFDYixTQUFTO1FBQ1QsVUFBVTtRQUNWLFFBQVE7SUFDVjtJQUNBLFFBQVEsRUFBRSxNQUFNLENBQUM7UUFDZixhQUFhLEVBQUUsSUFBSSxDQUFDO1lBQUM7WUFBVTtZQUFTO1NBQWM7UUFDdEQsU0FBUyxFQUFF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