import {
  For,
  Show,
  computed,
  createAgentSurface,
  createDialog,
  createForm,
  render,
  s,
  signal,
  type FormField,
} from "/dist/index.js";

type Category = "All" | "Workspace" | "Travel" | "Home";

interface Product {
  id: string;
  name: string;
  category: Exclude<Category, "All">;
  price: number;
  rating: number;
  color: string;
  mark: string;
  description: string;
}

interface CartLine extends Product {
  quantity: number;
}

const products: Product[] = [
  { id: "field-desk", name: "Field Desk", category: "Workspace", price: 420, rating: 4.9, color: "from-emerald-950 to-emerald-700", mark: "FD", description: "A compact solid-oak desk for focused rooms." },
  { id: "task-lamp", name: "Orbit Task Lamp", category: "Workspace", price: 148, rating: 4.8, color: "from-amber-200 to-orange-400", mark: "OL", description: "Warm, directional light with a tactile dimmer." },
  { id: "weekender", name: "Canvas Weekender", category: "Travel", price: 196, rating: 4.7, color: "from-stone-600 to-stone-900", mark: "CW", description: "Waxed canvas, brass hardware, carry-on proportions." },
  { id: "bottle", name: "All-Day Flask", category: "Travel", price: 42, rating: 4.9, color: "from-sky-200 to-cyan-600", mark: "AF", description: "Double-wall steel that stays cold through the commute." },
  { id: "throw", name: "Alpine Throw", category: "Home", price: 128, rating: 4.6, color: "from-rose-200 to-red-500", mark: "AT", description: "A soft recycled-wool layer woven in small batches." },
  { id: "tray", name: "Catchall Tray", category: "Home", price: 64, rating: 4.8, color: "from-orange-100 to-amber-700", mark: "CT", description: "Vegetable-tanned leather for the everyday essentials." },
  { id: "folio", name: "Project Folio", category: "Workspace", price: 78, rating: 4.5, color: "from-indigo-300 to-indigo-800", mark: "PF", description: "Refillable planning pages in a durable linen cover." },
  { id: "packing-cubes", name: "Transit Cubes", category: "Travel", price: 56, rating: 4.7, color: "from-teal-200 to-teal-700", mark: "TC", description: "Four featherweight organizers that compress cleanly." },
];

const query = signal("");
const category = signal<Category>("All");
const sort = signal<"featured" | "price-low" | "price-high">("featured");
const cart = signal<CartLine[]>([]);
const orderNumber = signal("");
const cartDialog = createDialog({ id: "shopping-cart" });
const categories: Category[] = ["All", "Workspace", "Travel", "Home"];

const visibleProducts = computed(() => {
  const search = query.value.trim().toLowerCase();
  const filtered = products.filter((product) =>
    (category.value === "All" || product.category === category.value)
    && (!search || `${product.name} ${product.description}`.toLowerCase().includes(search))
  );
  return [...filtered].sort((left, right) => {
    if (sort.value === "price-low") return left.price - right.price;
    if (sort.value === "price-high") return right.price - left.price;
    return right.rating - left.rating;
  });
});
const cartCount = computed(() => cart.value.reduce((total, line) => total + line.quantity, 0));
const subtotal = computed(() => cart.value.reduce((total, line) => total + line.price * line.quantity, 0));

const checkout = createForm({
  id: "checkout",
  initial: {
    name: "",
    email: "",
    address: "",
    country: "US" as "US" | "CA" | "GB",
    accepted: false,
  },
  schema: s.object({
    name: s.string({ min: 2, max: 80 }),
    email: s.email({ max: 160 }),
    address: s.string({ min: 8, max: 180 }),
    country: s.enum(["US", "CA", "GB"]),
    accepted: s.literal(true),
  }),
  validateOn: "blur",
  onSubmit: async (_values, { signal: abortSignal }) => {
    if (cart.peek().length === 0) throw new Error("Your cart is empty.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(abortSignal.reason);
      }, { once: true });
    });
    orderNumber.value = `NS-${Math.floor(100000 + Math.random() * 900000)}`;
    cart.value = [];
    return orderNumber.value;
  },
});

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function addToCart(product: Product) {
  cart.update((lines) => {
    const existing = lines.find((line) => line.id === product.id);
    return existing
      ? lines.map((line) => line.id === product.id ? { ...line, quantity: line.quantity + 1 } : line)
      : [...lines, { ...product, quantity: 1 }];
  });
}

function setQuantity(id: string, quantity: number) {
  cart.update((lines) => quantity <= 0
    ? lines.filter((line) => line.id !== id)
    : lines.map((line) => line.id === id ? { ...line, quantity } : line)
  );
}

function FieldError<Value>({ field }: { field: FormField<Value> }) {
  return <p {...field.error()} class="mt-1 text-xs font-medium text-red-700">{field.message.value}</p>;
}

function ProductCard({ product }: { product: Product }) {
  return (
    <article class="group">
      <div class={`relative aspect-[4/3] overflow-hidden rounded-[2rem] bg-gradient-to-br ${product.color} p-6 text-white shadow-sm transition duration-300 group-hover:-translate-y-1 group-hover:shadow-xl`}>
        <div class="absolute inset-0 bg-[radial-gradient(circle_at_75%_20%,rgba(255,255,255,.35),transparent_28%)]" />
        <span class="relative text-xs font-bold uppercase tracking-[.2em] opacity-70">{product.category}</span>
        <strong class="absolute bottom-5 right-6 text-5xl font-black tracking-[-.08em] opacity-35">{product.mark}</strong>
      </div>
      <div class="px-1 pt-5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="text-lg font-semibold">{product.name}</h3>
            <p class="mt-1 text-sm leading-6 text-black/55">{product.description}</p>
          </div>
          <strong class="shrink-0">{money(product.price)}</strong>
        </div>
        <div class="mt-4 flex items-center justify-between">
          <span class="text-sm text-black/55">★ {product.rating}</span>
          <button
            class="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-moss"
            onClick={() => addToCart(product)}
            agentId={`add-${product.id}`}
            agentLabel={`Add ${product.name} to cart`}
            agentAction="cart.add"
          >
            Add to cart
          </button>
        </div>
      </div>
    </article>
  );
}

function CartDialog() {
  const name = checkout.field("name");
  const email = checkout.field("email");
  const address = checkout.field("address");
  const country = checkout.field("country");
  const accepted = checkout.field("accepted");
  return (
    <>
      <div {...cartDialog.backdrop()} class="fixed inset-0 z-40 bg-ink/45 backdrop-blur-sm" />
      <aside
        {...cartDialog.dialog()}
        class="fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl sm:p-9"
        intent="shopping-cart"
      >
        <div class="flex items-center justify-between">
          <div>
            <p class="text-xs font-bold uppercase tracking-[.2em] text-moss">Your order</p>
            <h2 {...cartDialog.title()} class="mt-1 text-3xl font-semibold">Shopping cart</h2>
          </div>
          <button class="grid size-11 place-items-center rounded-full bg-black/5 text-xl" onClick={cartDialog.hide} agentId="close-cart" agentLabel="Close cart">×</button>
        </div>
        <p {...cartDialog.description()} class="mt-3 text-sm text-black/55">Review your items and securely enter delivery details.</p>

        <Show when={orderNumber.value} fallback={
          <>
            <div class="mt-8 space-y-4">
              <For each={cart.value} by="id" fallback={<p class="rounded-2xl bg-paper p-6 text-center text-black/55">Your cart is ready for something useful.</p>}>
                {(line) => (
                  <article class="flex items-center gap-4 rounded-2xl border border-black/8 p-4">
                    <div class={`grid size-16 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${line.color} font-black text-white`}>{line.mark}</div>
                    <div class="min-w-0 flex-1">
                      <h3 class="truncate font-semibold">{line.name}</h3>
                      <p class="text-sm text-black/50">{money(line.price)}</p>
                    </div>
                    <div class="flex items-center rounded-full border border-black/10">
                      <button class="px-3 py-1.5" onClick={() => setQuantity(line.id, line.quantity - 1)} agentLabel={`Decrease ${line.name} quantity`}>−</button>
                      <span class="min-w-6 text-center text-sm font-semibold">{line.quantity}</span>
                      <button class="px-3 py-1.5" onClick={() => setQuantity(line.id, line.quantity + 1)} agentLabel={`Increase ${line.name} quantity`}>+</button>
                    </div>
                  </article>
                )}
              </For>
            </div>
            <div class="my-7 flex items-center justify-between border-y border-black/10 py-5">
              <span class="text-black/55">Subtotal</span>
              <strong class="text-xl">{money(subtotal.value)}</strong>
            </div>
            <form {...checkout.props()} class="space-y-4">
              <div>
                <label class="text-sm font-semibold" for={name.id}>Full name</label>
                <input {...name.input({ type: "text" })} autocomplete="name" class="mt-1 w-full rounded-xl border border-black/15 px-4 py-3 focus:border-moss" />
                <FieldError field={name} />
              </div>
              <div>
                <label class="text-sm font-semibold" for={email.id}>Email</label>
                <input {...email.input({ type: "email" })} autocomplete="email" class="mt-1 w-full rounded-xl border border-black/15 px-4 py-3 focus:border-moss" />
                <FieldError field={email} />
              </div>
              <div>
                <label class="text-sm font-semibold" for={address.id}>Delivery address</label>
                <textarea {...address.textarea()} rows={3} autocomplete="street-address" class="mt-1 w-full resize-none rounded-xl border border-black/15 px-4 py-3 focus:border-moss" />
                <FieldError field={address} />
              </div>
              <div>
                <label class="text-sm font-semibold" for={country.id}>Country</label>
                <select {...country.select()} class="mt-1 w-full rounded-xl border border-black/15 bg-white px-4 py-3">
                  <option value="US">United States</option>
                  <option value="CA">Canada</option>
                  <option value="GB">United Kingdom</option>
                </select>
                <FieldError field={country} />
              </div>
              <label class="flex items-start gap-3 rounded-xl bg-paper p-4 text-sm">
                <input {...accepted.checkbox()} class="mt-1 size-4 accent-moss" />
                <span>I agree to the store terms and delivery policy.</span>
              </label>
              <FieldError field={accepted} />
              <p hidden={() => !checkout.error.value} class="text-sm font-medium text-red-700">{String(checkout.error.value ?? "")}</p>
              <button
                class="w-full rounded-full bg-sun px-5 py-3.5 font-bold text-ink disabled:cursor-not-allowed disabled:opacity-50"
                type="submit"
                disabled={checkout.pending.value || cartCount.value === 0}
                agentId="place-order"
                agentAction="checkout.submit"
                agentLabel="Place order"
              >
                {checkout.pending.value ? "Placing order…" : `Place order · ${money(subtotal.value)}`}
              </button>
            </form>
          </>
        }>
          <section class="mt-12 rounded-3xl bg-mint p-8 text-center">
            <div class="mx-auto grid size-16 place-items-center rounded-full bg-moss text-3xl text-white">✓</div>
            <h3 class="mt-5 text-2xl font-semibold">Order confirmed</h3>
            <p class="mt-2 text-black/60">Confirmation {orderNumber.value} is on its way to your inbox.</p>
            <button class="mt-6 rounded-full bg-ink px-5 py-2.5 font-semibold text-white" onClick={() => { orderNumber.value = ""; checkout.reset(); cartDialog.hide(); }}>Continue shopping</button>
          </section>
        </Show>
      </aside>
    </>
  );
}

function App() {
  return (
    <div class="min-h-screen">
      <header class="sticky top-0 z-30 border-b border-black/8 bg-paper/90 backdrop-blur-xl">
        <div class="mx-auto flex max-w-7xl items-center gap-6 px-5 py-4 sm:px-8">
          <a href="#" class="text-xl font-black tracking-[-.04em]">NORTHSTAR<span class="text-moss">/SUPPLY</span></a>
          <nav class="hidden flex-1 justify-center gap-7 text-sm font-semibold md:flex" aria-label="Primary">
            <a href="#shop">Shop</a><a href="#story">Our story</a><a href="#journal">Journal</a>
          </nav>
          <button {...cartDialog.trigger({ agentId: "open-cart", agentLabel: "Open shopping cart" })} class="ml-auto rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
            Cart <span class="ml-2 rounded-full bg-sun px-2 py-0.5 text-xs text-ink">{cartCount.value}</span>
          </button>
        </div>
      </header>

      <main id="shop">
        <section class="mx-auto grid max-w-7xl gap-10 px-5 py-12 sm:px-8 lg:grid-cols-[1.2fr_.8fr] lg:py-20">
          <div class="self-center">
            <p class="text-xs font-black uppercase tracking-[.24em] text-moss">Goods for useful days</p>
            <h1 class="mt-4 max-w-3xl text-5xl font-semibold leading-[.94] tracking-[-.05em] sm:text-7xl">Objects that earn their place.</h1>
            <p class="mt-6 max-w-xl text-lg leading-8 text-black/58">A small collection of durable workspace, travel, and home essentials—selected for how well they age.</p>
          </div>
          <div class="relative min-h-80 overflow-hidden rounded-[2.5rem] bg-ink p-8 text-white">
            <div class="absolute -right-16 -top-14 size-72 rounded-full bg-sun/80 blur-2xl" />
            <div class="absolute -bottom-20 left-8 size-72 rounded-full bg-moss blur-2xl" />
            <div class="relative flex h-full flex-col justify-between">
              <span class="text-xs font-bold uppercase tracking-[.2em] text-white/60">Edition 04 · Summer fieldwork</span>
              <div><strong class="block text-6xl font-black tracking-[-.08em]">8</strong><span class="text-white/70">considered essentials</span></div>
            </div>
          </div>
        </section>

        <section class="mx-auto max-w-7xl px-5 pb-24 sm:px-8">
          <div class="mb-10 grid gap-4 lg:grid-cols-[1fr_auto_auto]">
            <label class="relative">
              <span class="sr-only">Search products</span>
              <input class="w-full rounded-full border border-black/12 bg-white px-5 py-3" placeholder="Search the collection…" bind:value={query} id="product-search" name="search" />
            </label>
            <div class="flex flex-wrap gap-2" role="group" aria-label="Product categories">
              <For each={categories}>
                {(name) => (
                  <button
                    class="rounded-full border border-black/12 px-4 py-2.5 text-sm font-semibold"
                    classList={{ "bg-ink text-white": category.value === name }}
                    onClick={() => { category.value = name; }}
                    agentId={`category-${name.toLowerCase()}`}
                    agentLabel={`Show ${name} products`}
                  >
                    {name}
                  </button>
                )}
              </For>
            </div>
            <select class="rounded-full border border-black/12 bg-white px-4 py-2.5 text-sm font-semibold" bind:value={sort} id="product-sort" aria-label="Sort products">
              <option value="featured">Featured</option>
              <option value="price-low">Price: low to high</option>
              <option value="price-high">Price: high to low</option>
            </select>
          </div>
          <p class="mb-6 text-sm text-black/50">{visibleProducts.value.length} products</p>
          <div class="grid gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            <For each={visibleProducts.value} by="id" fallback={<p class="col-span-full rounded-3xl bg-white p-12 text-center text-black/50">No products match that search.</p>}>
              {(product) => <ProductCard product={product} />}
            </For>
          </div>
        </section>
      </main>
      <CartDialog />
    </div>
  );
}

render(document.querySelector("#app")!, <App />);
Object.assign(globalThis, { commerce: { cart, checkout, surface: createAgentSurface(document.querySelector("#app")!) } });
