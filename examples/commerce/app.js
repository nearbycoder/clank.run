import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "/dist/index.js";
import { For, Show, computed, createAgentSurface, createDialog, createForm, render, s, signal } from "/dist/index.js";
const products = [
    {
        id: "field-desk",
        name: "Field Desk",
        category: "Workspace",
        price: 420,
        rating: 4.9,
        color: "from-emerald-950 to-emerald-700",
        mark: "FD",
        description: "A compact solid-oak desk for focused rooms."
    },
    {
        id: "task-lamp",
        name: "Orbit Task Lamp",
        category: "Workspace",
        price: 148,
        rating: 4.8,
        color: "from-amber-200 to-orange-400",
        mark: "OL",
        description: "Warm, directional light with a tactile dimmer."
    },
    {
        id: "weekender",
        name: "Canvas Weekender",
        category: "Travel",
        price: 196,
        rating: 4.7,
        color: "from-stone-600 to-stone-900",
        mark: "CW",
        description: "Waxed canvas, brass hardware, carry-on proportions."
    },
    {
        id: "bottle",
        name: "All-Day Flask",
        category: "Travel",
        price: 42,
        rating: 4.9,
        color: "from-sky-200 to-cyan-600",
        mark: "AF",
        description: "Double-wall steel that stays cold through the commute."
    },
    {
        id: "throw",
        name: "Alpine Throw",
        category: "Home",
        price: 128,
        rating: 4.6,
        color: "from-rose-200 to-red-500",
        mark: "AT",
        description: "A soft recycled-wool layer woven in small batches."
    },
    {
        id: "tray",
        name: "Catchall Tray",
        category: "Home",
        price: 64,
        rating: 4.8,
        color: "from-orange-100 to-amber-700",
        mark: "CT",
        description: "Vegetable-tanned leather for the everyday essentials."
    },
    {
        id: "folio",
        name: "Project Folio",
        category: "Workspace",
        price: 78,
        rating: 4.5,
        color: "from-indigo-300 to-indigo-800",
        mark: "PF",
        description: "Refillable planning pages in a durable linen cover."
    },
    {
        id: "packing-cubes",
        name: "Transit Cubes",
        category: "Travel",
        price: 56,
        rating: 4.7,
        color: "from-teal-200 to-teal-700",
        mark: "TC",
        description: "Four featherweight organizers that compress cleanly."
    }
];
const query = signal("");
const category = signal("All");
const sort = signal("featured");
const cart = signal([]);
const orderNumber = signal("");
const cartDialog = createDialog({
    id: "shopping-cart"
});
const categories = [
    "All",
    "Workspace",
    "Travel",
    "Home"
];
const visibleProducts = computed(()=>{
    const search = query.value.trim().toLowerCase();
    const filtered = products.filter((product)=>(category.value === "All" || product.category === category.value) && (!search || `${product.name} ${product.description}`.toLowerCase().includes(search)));
    return [
        ...filtered
    ].sort((left, right)=>{
        if (sort.value === "price-low") return left.price - right.price;
        if (sort.value === "price-high") return right.price - left.price;
        return right.rating - left.rating;
    });
});
const cartCount = computed(()=>cart.value.reduce((total, line)=>total + line.quantity, 0));
const subtotal = computed(()=>cart.value.reduce((total, line)=>total + line.price * line.quantity, 0));
const checkout = createForm({
    id: "checkout",
    initial: {
        name: "",
        email: "",
        address: "",
        country: "US",
        accepted: false
    },
    schema: s.object({
        name: s.string({
            min: 2,
            max: 80
        }),
        email: s.email({
            max: 160
        }),
        address: s.string({
            min: 8,
            max: 180
        }),
        country: s.enum([
            "US",
            "CA",
            "GB"
        ]),
        accepted: s.literal(true)
    }),
    validateOn: "blur",
    onSubmit: async (_values, { signal: abortSignal })=>{
        if (cart.peek().length === 0) throw new Error("Your cart is empty.");
        await new Promise((resolve, reject)=>{
            const timer = setTimeout(resolve, 500);
            abortSignal.addEventListener("abort", ()=>{
                clearTimeout(timer);
                reject(abortSignal.reason);
            }, {
                once: true
            });
        });
        orderNumber.value = `NS-${Math.floor(100000 + Math.random() * 900000)}`;
        cart.value = [];
        return orderNumber.value;
    }
});
function money(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(value);
}
function addToCart(product) {
    cart.update((lines)=>{
        const existing = lines.find((line)=>line.id === product.id);
        return existing ? lines.map((line)=>line.id === product.id ? {
                ...line,
                quantity: line.quantity + 1
            } : line) : [
            ...lines,
            {
                ...product,
                quantity: 1
            }
        ];
    });
}
function setQuantity(id, quantity) {
    cart.update((lines)=>quantity <= 0 ? lines.filter((line)=>line.id !== id) : lines.map((line)=>line.id === id ? {
                ...line,
                quantity
            } : line));
}
function FieldError({ field }) {
    return __clankJSX("p", {
        ...field.error(),
        "class": "mt-1 text-xs font-medium text-red-700"
    }, __clankExpression(()=>field.message.value));
}
function ProductCard({ product }) {
    return __clankJSX("article", {
        "class": "group"
    }, __clankJSX("div", {
        "class": __clankExpression(()=>`relative aspect-[4/3] overflow-hidden rounded-[2rem] bg-gradient-to-br ${product.color} p-6 text-white shadow-sm transition duration-300 group-hover:-translate-y-1 group-hover:shadow-xl`)
    }, __clankJSX("div", {
        "class": "absolute inset-0 bg-[radial-gradient(circle_at_75%_20%,rgba(255,255,255,.35),transparent_28%)]"
    }), __clankJSX("span", {
        "class": "relative text-xs font-bold uppercase tracking-[.2em] opacity-70"
    }, __clankExpression(()=>product.category)), __clankJSX("strong", {
        "class": "absolute bottom-5 right-6 text-5xl font-black tracking-[-.08em] opacity-35"
    }, __clankExpression(()=>product.mark))), __clankJSX("div", {
        "class": "px-1 pt-5"
    }, __clankJSX("div", {
        "class": "flex items-start justify-between gap-4"
    }, __clankJSX("div", {}, __clankJSX("h3", {
        "class": "text-lg font-semibold"
    }, __clankExpression(()=>product.name)), __clankJSX("p", {
        "class": "mt-1 text-sm leading-6 text-black/55"
    }, __clankExpression(()=>product.description))), __clankJSX("strong", {
        "class": "shrink-0"
    }, __clankExpression(()=>money(product.price)))), __clankJSX("div", {
        "class": "mt-4 flex items-center justify-between"
    }, __clankJSX("span", {
        "class": "text-sm text-black/55"
    }, "★ ", __clankExpression(()=>product.rating)), __clankJSX("button", {
        "class": "rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-moss",
        "onClick": ()=>addToCart(product),
        "agentId": __clankExpression(()=>`add-${product.id}`),
        "agentLabel": __clankExpression(()=>`Add ${product.name} to cart`),
        "agentAction": "cart.add"
    }, " Add to cart "))));
}
function CartDialog() {
    const name = checkout.field("name");
    const email = checkout.field("email");
    const address = checkout.field("address");
    const country = checkout.field("country");
    const accepted = checkout.field("accepted");
    return __clankJSX(__clankFragment, {}, __clankJSX("div", {
        ...cartDialog.backdrop(),
        "class": "fixed inset-0 z-40 bg-ink/45 backdrop-blur-sm"
    }), __clankJSX("aside", {
        ...cartDialog.dialog(),
        "class": "fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl sm:p-9",
        "intent": "shopping-cart"
    }, __clankJSX("div", {
        "class": "flex items-center justify-between"
    }, __clankJSX("div", {}, __clankJSX("p", {
        "class": "text-xs font-bold uppercase tracking-[.2em] text-moss"
    }, "Your order"), __clankJSX("h2", {
        ...cartDialog.title(),
        "class": "mt-1 text-3xl font-semibold"
    }, "Shopping cart")), __clankJSX("button", {
        "class": "grid size-11 place-items-center rounded-full bg-black/5 text-xl",
        "onClick": cartDialog.hide,
        "agentId": "close-cart",
        "agentLabel": "Close cart"
    }, "×")), __clankJSX("p", {
        ...cartDialog.description(),
        "class": "mt-3 text-sm text-black/55"
    }, "Review your items and securely enter delivery details."), __clankJSX(Show, {
        "when": __clankExpression(()=>orderNumber.value),
        "fallback": __clankJSX(__clankFragment, {}, __clankJSX("div", {
            "class": "mt-8 space-y-4"
        }, __clankJSX(For, {
            "each": __clankExpression(()=>cart.value),
            "by": "id",
            "fallback": __clankJSX("p", {
                "class": "rounded-2xl bg-paper p-6 text-center text-black/55"
            }, "Your cart is ready for something useful.")
        }, (line)=>__clankJSX("article", {
                "class": "flex items-center gap-4 rounded-2xl border border-black/8 p-4"
            }, __clankJSX("div", {
                "class": __clankExpression(()=>`grid size-16 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${line.color} font-black text-white`)
            }, __clankExpression(()=>line.mark)), __clankJSX("div", {
                "class": "min-w-0 flex-1"
            }, __clankJSX("h3", {
                "class": "truncate font-semibold"
            }, __clankExpression(()=>line.name)), __clankJSX("p", {
                "class": "text-sm text-black/50"
            }, __clankExpression(()=>money(line.price)))), __clankJSX("div", {
                "class": "flex items-center rounded-full border border-black/10"
            }, __clankJSX("button", {
                "class": "px-3 py-1.5",
                "onClick": ()=>setQuantity(line.id, line.quantity - 1),
                "agentLabel": __clankExpression(()=>`Decrease ${line.name} quantity`)
            }, "−"), __clankJSX("span", {
                "class": "min-w-6 text-center text-sm font-semibold"
            }, __clankExpression(()=>line.quantity)), __clankJSX("button", {
                "class": "px-3 py-1.5",
                "onClick": ()=>setQuantity(line.id, line.quantity + 1),
                "agentLabel": __clankExpression(()=>`Increase ${line.name} quantity`)
            }, "+"))))), __clankJSX("div", {
            "class": "my-7 flex items-center justify-between border-y border-black/10 py-5"
        }, __clankJSX("span", {
            "class": "text-black/55"
        }, "Subtotal"), __clankJSX("strong", {
            "class": "text-xl"
        }, __clankExpression(()=>money(subtotal.value)))), __clankJSX("form", {
            ...checkout.props(),
            "class": "space-y-4"
        }, __clankJSX("div", {}, __clankJSX("label", {
            "class": "text-sm font-semibold",
            "for": __clankExpression(()=>name.id)
        }, "Full name"), __clankJSX("input", {
            ...name.input({
                type: "text"
            }),
            "autocomplete": "name",
            "class": "mt-1 w-full rounded-xl border border-black/15 px-4 py-3 focus:border-moss"
        }), __clankJSX(FieldError, {
            "field": __clankExpression(()=>name)
        })), __clankJSX("div", {}, __clankJSX("label", {
            "class": "text-sm font-semibold",
            "for": __clankExpression(()=>email.id)
        }, "Email"), __clankJSX("input", {
            ...email.input({
                type: "email"
            }),
            "autocomplete": "email",
            "class": "mt-1 w-full rounded-xl border border-black/15 px-4 py-3 focus:border-moss"
        }), __clankJSX(FieldError, {
            "field": __clankExpression(()=>email)
        })), __clankJSX("div", {}, __clankJSX("label", {
            "class": "text-sm font-semibold",
            "for": __clankExpression(()=>address.id)
        }, "Delivery address"), __clankJSX("textarea", {
            ...address.textarea(),
            "rows": 3,
            "autocomplete": "street-address",
            "class": "mt-1 w-full resize-none rounded-xl border border-black/15 px-4 py-3 focus:border-moss"
        }), __clankJSX(FieldError, {
            "field": __clankExpression(()=>address)
        })), __clankJSX("div", {}, __clankJSX("label", {
            "class": "text-sm font-semibold",
            "for": __clankExpression(()=>country.id)
        }, "Country"), __clankJSX("select", {
            ...country.select(),
            "class": "mt-1 w-full rounded-xl border border-black/15 bg-white px-4 py-3"
        }, __clankJSX("option", {
            "value": "US"
        }, "United States"), __clankJSX("option", {
            "value": "CA"
        }, "Canada"), __clankJSX("option", {
            "value": "GB"
        }, "United Kingdom")), __clankJSX(FieldError, {
            "field": __clankExpression(()=>country)
        })), __clankJSX("label", {
            "class": "flex items-start gap-3 rounded-xl bg-paper p-4 text-sm"
        }, __clankJSX("input", {
            ...accepted.checkbox(),
            "class": "mt-1 size-4 accent-moss"
        }), __clankJSX("span", {}, "I agree to the store terms and delivery policy.")), __clankJSX(FieldError, {
            "field": __clankExpression(()=>accepted)
        }), __clankJSX("p", {
            "hidden": ()=>!checkout.error.value,
            "class": "text-sm font-medium text-red-700"
        }, __clankExpression(()=>String(checkout.error.value ?? ""))), __clankJSX("button", {
            "class": "w-full rounded-full bg-sun px-5 py-3.5 font-bold text-ink disabled:cursor-not-allowed disabled:opacity-50",
            "type": "submit",
            "disabled": __clankExpression(()=>checkout.pending.value || cartCount.value === 0),
            "agentId": "place-order",
            "agentAction": "checkout.submit",
            "agentLabel": "Place order"
        }, __clankExpression(()=>checkout.pending.value ? "Placing order…" : `Place order · ${money(subtotal.value)}`))))
    }, __clankJSX("section", {
        "class": "mt-12 rounded-3xl bg-mint p-8 text-center"
    }, __clankJSX("div", {
        "class": "mx-auto grid size-16 place-items-center rounded-full bg-moss text-3xl text-white"
    }, "✓"), __clankJSX("h3", {
        "class": "mt-5 text-2xl font-semibold"
    }, "Order confirmed"), __clankJSX("p", {
        "class": "mt-2 text-black/60"
    }, "Confirmation ", __clankExpression(()=>orderNumber.value), " is on its way to your inbox."), __clankJSX("button", {
        "class": "mt-6 rounded-full bg-ink px-5 py-2.5 font-semibold text-white",
        "onClick": ()=>{
            orderNumber.value = "";
            checkout.reset();
            cartDialog.hide();
        }
    }, "Continue shopping")))));
}
function App() {
    return __clankJSX("div", {
        "class": "min-h-screen"
    }, __clankJSX("header", {
        "class": "sticky top-0 z-30 border-b border-black/8 bg-paper/90 backdrop-blur-xl"
    }, __clankJSX("div", {
        "class": "mx-auto flex max-w-7xl items-center gap-6 px-5 py-4 sm:px-8"
    }, __clankJSX("a", {
        "href": "#",
        "class": "text-xl font-black tracking-[-.04em]"
    }, "NORTHSTAR", __clankJSX("span", {
        "class": "text-moss"
    }, "/SUPPLY")), __clankJSX("nav", {
        "class": "hidden flex-1 justify-center gap-7 text-sm font-semibold md:flex",
        "aria-label": "Primary"
    }, __clankJSX("a", {
        "href": "#shop"
    }, "Shop"), __clankJSX("a", {
        "href": "#story"
    }, "Our story"), __clankJSX("a", {
        "href": "#journal"
    }, "Journal")), __clankJSX("button", {
        ...cartDialog.trigger({
            agentId: "open-cart",
            agentLabel: "Open shopping cart"
        }),
        "class": "ml-auto rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white"
    }, " Cart ", __clankJSX("span", {
        "class": "ml-2 rounded-full bg-sun px-2 py-0.5 text-xs text-ink"
    }, __clankExpression(()=>cartCount.value))))), __clankJSX("main", {
        "id": "shop"
    }, __clankJSX("section", {
        "class": "mx-auto grid max-w-7xl gap-10 px-5 py-12 sm:px-8 lg:grid-cols-[1.2fr_.8fr] lg:py-20"
    }, __clankJSX("div", {
        "class": "self-center"
    }, __clankJSX("p", {
        "class": "text-xs font-black uppercase tracking-[.24em] text-moss"
    }, "Goods for useful days"), __clankJSX("h1", {
        "class": "mt-4 max-w-3xl text-5xl font-semibold leading-[.94] tracking-[-.05em] sm:text-7xl"
    }, "Objects that earn their place."), __clankJSX("p", {
        "class": "mt-6 max-w-xl text-lg leading-8 text-black/58"
    }, "A small collection of durable workspace, travel, and home essentials—selected for how well they age.")), __clankJSX("div", {
        "class": "relative min-h-80 overflow-hidden rounded-[2.5rem] bg-ink p-8 text-white"
    }, __clankJSX("div", {
        "class": "absolute -right-16 -top-14 size-72 rounded-full bg-sun/80 blur-2xl"
    }), __clankJSX("div", {
        "class": "absolute -bottom-20 left-8 size-72 rounded-full bg-moss blur-2xl"
    }), __clankJSX("div", {
        "class": "relative flex h-full flex-col justify-between"
    }, __clankJSX("span", {
        "class": "text-xs font-bold uppercase tracking-[.2em] text-white/60"
    }, "Edition 04 · Summer fieldwork"), __clankJSX("div", {}, __clankJSX("strong", {
        "class": "block text-6xl font-black tracking-[-.08em]"
    }, "8"), __clankJSX("span", {
        "class": "text-white/70"
    }, "considered essentials"))))), __clankJSX("section", {
        "class": "mx-auto max-w-7xl px-5 pb-24 sm:px-8"
    }, __clankJSX("div", {
        "class": "mb-10 grid gap-4 lg:grid-cols-[1fr_auto_auto]"
    }, __clankJSX("label", {
        "class": "relative"
    }, __clankJSX("span", {
        "class": "sr-only"
    }, "Search products"), __clankJSX("input", {
        "class": "w-full rounded-full border border-black/12 bg-white px-5 py-3",
        "placeholder": "Search the collection…",
        "bind:value": query,
        "id": "product-search",
        "name": "search"
    })), __clankJSX("div", {
        "class": "flex flex-wrap gap-2",
        "role": "group",
        "aria-label": "Product categories"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>categories)
    }, (name)=>__clankJSX("button", {
            "class": "rounded-full border border-black/12 px-4 py-2.5 text-sm font-semibold",
            "classList": __clankExpression(()=>({
                    "bg-ink text-white": category.value === name
                })),
            "onClick": ()=>{
                category.value = name;
            },
            "agentId": __clankExpression(()=>`category-${name.toLowerCase()}`),
            "agentLabel": __clankExpression(()=>`Show ${name} products`)
        }, __clankExpression(()=>name)))), __clankJSX("select", {
        "class": "rounded-full border border-black/12 bg-white px-4 py-2.5 text-sm font-semibold",
        "bind:value": sort,
        "id": "product-sort",
        "aria-label": "Sort products"
    }, __clankJSX("option", {
        "value": "featured"
    }, "Featured"), __clankJSX("option", {
        "value": "price-low"
    }, "Price: low to high"), __clankJSX("option", {
        "value": "price-high"
    }, "Price: high to low"))), __clankJSX("p", {
        "class": "mb-6 text-sm text-black/50"
    }, __clankExpression(()=>visibleProducts.value.length), " products"), __clankJSX("div", {
        "class": "grid gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-3"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>visibleProducts.value),
        "by": "id",
        "fallback": __clankJSX("p", {
            "class": "col-span-full rounded-3xl bg-white p-12 text-center text-black/50"
        }, "No products match that search.")
    }, (product)=>__clankJSX(ProductCard, {
            "product": __clankExpression(()=>product)
        }))))), __clankJSX(CartDialog, {}));
}
render(document.querySelector("#app"), __clankJSX(App, {}));
Object.assign(globalThis, {
    commerce: {
        cart,
        checkout,
        surface: createAgentSurface(document.querySelector("#app"))
    }
});


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9jb21tZXJjZS9hcHAudHN4Il0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLFNBQVMsT0FBTyxVQUFVLEVBQUUsWUFBWSxlQUFlLEVBQUUsY0FBYyxpQkFBaUIsUUFBUSxpQkFBaUI7QUFDakgsU0FDRSxHQUFHLEVBQ0gsSUFBSSxFQUNKLFFBQVEsRUFDUixrQkFBa0IsRUFDbEIsWUFBWSxFQUNaLFVBQVUsRUFDVixNQUFNLEVBQ04sQ0FBQyxFQUNELE1BQU0sUUFFRCxpQkFBaUI7QUFtQnhCLE1BQU0sV0FBc0I7SUFDMUI7UUFBRSxJQUFJO1FBQWMsTUFBTTtRQUFjLFVBQVU7UUFBYSxPQUFPO1FBQUssUUFBUTtRQUFLLE9BQU87UUFBbUMsTUFBTTtRQUFNLGFBQWE7SUFBOEM7SUFDek07UUFBRSxJQUFJO1FBQWEsTUFBTTtRQUFtQixVQUFVO1FBQWEsT0FBTztRQUFLLFFBQVE7UUFBSyxPQUFPO1FBQWdDLE1BQU07UUFBTSxhQUFhO0lBQWlEO0lBQzdNO1FBQUUsSUFBSTtRQUFhLE1BQU07UUFBb0IsVUFBVTtRQUFVLE9BQU87UUFBSyxRQUFRO1FBQUssT0FBTztRQUErQixNQUFNO1FBQU0sYUFBYTtJQUFzRDtJQUMvTTtRQUFFLElBQUk7UUFBVSxNQUFNO1FBQWlCLFVBQVU7UUFBVSxPQUFPO1FBQUksUUFBUTtRQUFLLE9BQU87UUFBNEIsTUFBTTtRQUFNLGFBQWE7SUFBeUQ7SUFDeE07UUFBRSxJQUFJO1FBQVMsTUFBTTtRQUFnQixVQUFVO1FBQVEsT0FBTztRQUFLLFFBQVE7UUFBSyxPQUFPO1FBQTRCLE1BQU07UUFBTSxhQUFhO0lBQXFEO0lBQ2pNO1FBQUUsSUFBSTtRQUFRLE1BQU07UUFBaUIsVUFBVTtRQUFRLE9BQU87UUFBSSxRQUFRO1FBQUssT0FBTztRQUFnQyxNQUFNO1FBQU0sYUFBYTtJQUF3RDtJQUN2TTtRQUFFLElBQUk7UUFBUyxNQUFNO1FBQWlCLFVBQVU7UUFBYSxP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