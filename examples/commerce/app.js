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
        ...cartDialog.close({
            agentId: "close-cart",
            agentLabel: "Close cart"
        }),
        "class": "grid size-11 place-items-center rounded-full bg-black/5 text-xl"
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


//# sourceURL=/home/nearby/Sites/clank/examples/commerce/app.tsx