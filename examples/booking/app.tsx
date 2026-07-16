import {
  For,
  Show,
  computed,
  createAgentSurface,
  createDisclosure,
  createForm,
  render,
  s,
  signal,
  type FormField,
} from "/dist/index.js";

type Destination = "Lisbon" | "Kyoto" | "Mexico City";
type RoomId = "courtyard" | "skyline" | "suite";

interface Room {
  id: RoomId;
  name: string;
  description: string;
  price: number;
  size: string;
  tone: string;
  features: string[];
}

const rooms: Room[] = [
  { id: "courtyard", name: "Courtyard Room", description: "Quiet, tactile, and filled with soft morning light.", price: 188, size: "28 m²", tone: "from-amber-100 to-orange-300", features: ["Queen bed", "Garden outlook", "Rain shower"] },
  { id: "skyline", name: "Skyline Studio", description: "A generous corner studio above the neighborhood rooftops.", price: 264, size: "39 m²", tone: "from-sky-200 to-blue-500", features: ["King bed", "City view", "Reading lounge"] },
  { id: "suite", name: "Terrace Suite", description: "Separate living space and a private terrace for slow evenings.", price: 376, size: "58 m²", tone: "from-emerald-200 to-teal-600", features: ["King bed", "Private terrace", "Soaking tub"] },
];

const step = signal<1 | 2 | 3 | 4>(1);
const selectedRoom = signal<RoomId>("skyline");
const confirmation = signal("");
const details = createDisclosure({ id: "booking-details", initialOpen: true });

const search = createForm({
  id: "stay-search",
  initial: {
    destination: "Lisbon" as Destination,
    checkIn: "2026-09-18",
    checkOut: "2026-09-22",
    guests: 2,
  },
  schema: s.object({
    destination: s.enum(["Lisbon", "Kyoto", "Mexico City"]),
    checkIn: s.date(),
    checkOut: s.date(),
    guests: s.number({ integer: true, min: 1, max: 6 }),
  }),
  validateOn: "blur",
  validate(values) {
    return values.checkOut <= values.checkIn
      ? { checkOut: "Check-out must be after check-in." }
      : undefined;
  },
});

const guest = createForm({
  id: "guest-details",
  initial: {
    firstName: "",
    lastName: "",
    email: "",
    requests: "",
    accepted: false,
  },
  schema: s.object({
    firstName: s.string({ min: 2, max: 60 }),
    lastName: s.string({ min: 2, max: 60 }),
    email: s.email({ max: 160 }),
    requests: s.string({ max: 500 }),
    accepted: s.literal(true),
  }),
  validateOn: "blur",
  onSubmit: async (_values, { signal: abortSignal }) => {
    await pause(650, abortSignal);
    confirmation.value = `EW-${Math.floor(100000 + Math.random() * 900000)}`;
    step.value = 4;
    return confirmation.value;
  },
});

const nights = computed(() => {
  const values = search.values.value;
  const milliseconds = Date.parse(`${values.checkOut}T00:00:00Z`) - Date.parse(`${values.checkIn}T00:00:00Z`);
  return Math.max(1, Math.round(milliseconds / 86_400_000));
});
const room = computed(() => rooms.find((entry) => entry.id === selectedRoom.value)!);
const subtotal = computed(() => room.value.price * nights.value);
const service = computed(() => Math.round(subtotal.value * 0.12));
const total = computed(() => subtotal.value + service.value);

function pause(milliseconds: number, abortSignal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    abortSignal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortSignal.reason);
    }, { once: true });
  });
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function readableDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00Z`));
}

function FieldError<Value>({ field }: { field: FormField<Value> }) {
  return <p {...field.error()} class="mt-1 text-xs font-semibold text-red-700">{field.message.value}</p>;
}

function Progress() {
  const steps = ["Stay", "Room", "Details", "Confirmed"];
  return (
    <ol class="grid grid-cols-4 gap-2" aria-label="Booking progress">
      <For each={steps}>
        {(label, index) => {
          const number = index() + 1;
          return (
            <li class="flex items-center gap-2">
              <span
                class="grid size-8 shrink-0 place-items-center rounded-full border border-night/15 text-xs font-bold"
                classList={{ "border-ocean bg-ocean text-white": step.value >= number }}
                aria-current={step.value === number ? "step" : undefined}
              >
                {step.value > number ? "✓" : number}
              </span>
              <span class="hidden text-xs font-semibold sm:block" classList={{ "text-ocean": step.value === number, "text-night/40": step.value !== number }}>{label}</span>
            </li>
          );
        }}
      </For>
    </ol>
  );
}

function SearchStep() {
  const destination = search.field("destination");
  const checkIn = search.field("checkIn");
  const checkOut = search.field("checkOut");
  const guests = search.field("guests");
  const next = (event: Event) => {
    event.preventDefault();
    if (search.validate("submit")) step.value = 2;
    else search.focusFirstError();
  };
  return (
    <section hidden={() => step.value !== 1}>
      <p class="text-xs font-black uppercase tracking-[.22em] text-ocean">Find your stay</p>
      <h1 class="mt-3 text-4xl font-semibold tracking-[-.04em] sm:text-5xl">Where should we wake up?</h1>
      <p class="mt-4 max-w-xl leading-7 text-night/55">Thoughtful neighborhood hotels, selected for design, hospitality, and a real sense of place.</p>
      <form class="mt-9 grid gap-5" onSubmit={next} noValidate>
        <div><label class="text-sm font-semibold" for={destination.id}>Destination</label><select {...destination.select()} class="mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5"><option>Lisbon</option><option>Kyoto</option><option>Mexico City</option></select><FieldError field={destination} /></div>
        <div class="grid gap-5 sm:grid-cols-2">
          <div><label class="text-sm font-semibold" for={checkIn.id}>Check-in</label><input {...checkIn.input({ type: "date" })} class="mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5" /><FieldError field={checkIn} /></div>
          <div><label class="text-sm font-semibold" for={checkOut.id}>Check-out</label><input {...checkOut.input({ type: "date" })} class="mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5" /><FieldError field={checkOut} /></div>
        </div>
        <div><label class="text-sm font-semibold" for={guests.id}>Guests</label><input {...guests.input({ type: "number" })} min={1} max={6} class="mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5" /><FieldError field={guests} /></div>
        <button class="mt-2 rounded-full bg-night px-6 py-4 font-bold text-white hover:bg-ocean" type="submit" agentId="search-stays" agentAction="booking.search">See available rooms</button>
      </form>
    </section>
  );
}

function RoomStep() {
  return (
    <section hidden={() => step.value !== 2}>
      <p class="text-xs font-black uppercase tracking-[.22em] text-ocean">Choose a room</p>
      <h1 class="mt-3 text-4xl font-semibold tracking-[-.04em]">A good place to land.</h1>
      <p class="mt-3 text-night/50">{readableDate(search.values.value.checkIn)} – {readableDate(search.values.value.checkOut)} · {search.values.value.guests} guests</p>
      <div class="mt-8 space-y-4" role="radiogroup" aria-label="Available rooms">
        <For each={rooms} by="id">
          {(option) => (
            <label
              class="grid cursor-pointer gap-5 rounded-3xl border border-night/10 bg-white p-4 transition hover:border-ocean sm:grid-cols-[9rem_1fr_auto]"
              classList={{ "border-ocean ring-2 ring-ocean/15": selectedRoom.value === option.id }}
            >
              <div class={`min-h-32 rounded-2xl bg-gradient-to-br ${option.tone}`} />
              <div class="self-center">
                <div class="flex items-center gap-3"><h2 class="text-xl font-semibold">{option.name}</h2><span class="text-xs text-night/40">{option.size}</span></div>
                <p class="mt-2 text-sm leading-6 text-night/50">{option.description}</p>
                <p class="mt-3 text-xs font-semibold text-ocean">{option.features.join(" · ")}</p>
              </div>
              <div class="flex items-center justify-between gap-4 sm:block sm:text-right">
                <input type="radio" name="room" value={option.id} checked={selectedRoom.value === option.id} onChange={() => { selectedRoom.value = option.id; }} class="size-5 accent-ocean" agentId={`room-${option.id}`} agentLabel={`Select ${option.name}`} />
                <p class="sm:mt-7"><strong class="text-xl">{money(option.price)}</strong><span class="block text-xs text-night/40">per night</span></p>
              </div>
            </label>
          )}
        </For>
      </div>
      <div class="mt-8 flex justify-between gap-4">
        <button class="rounded-full border border-night/15 px-6 py-3 font-semibold" onClick={() => { step.value = 1; }}>Back</button>
        <button class="rounded-full bg-night px-6 py-3 font-bold text-white" onClick={() => { step.value = 3; }} agentId="continue-to-details">Continue</button>
      </div>
    </section>
  );
}

function GuestStep() {
  const firstName = guest.field("firstName");
  const lastName = guest.field("lastName");
  const email = guest.field("email");
  const requests = guest.field("requests");
  const accepted = guest.field("accepted");
  return (
    <section hidden={() => step.value !== 3}>
      <p class="text-xs font-black uppercase tracking-[.22em] text-ocean">Almost there</p>
      <h1 class="mt-3 text-4xl font-semibold tracking-[-.04em]">Who are we welcoming?</h1>
      <form {...guest.props()} class="mt-8 grid gap-5">
        <div class="grid gap-5 sm:grid-cols-2">
          <div><label class="text-sm font-semibold" for={firstName.id}>First name</label><input {...firstName.input()} autocomplete="given-name" class="mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5" /><FieldError field={firstName} /></div>
          <div><label class="text-sm font-semibold" for={lastName.id}>Last name</label><input {...lastName.input()} autocomplete="family-name" class="mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5" /><FieldError field={lastName} /></div>
        </div>
        <div><label class="text-sm font-semibold" for={email.id}>Email</label><input {...email.input({ type: "email" })} autocomplete="email" class="mt-2 w-full rounded-2xl border border-night/12 bg-white px-4 py-3.5" /><FieldError field={email} /></div>
        <div><label class="text-sm font-semibold" for={requests.id}>Special requests <span class="font-normal text-night/40">(optional)</span></label><textarea {...requests.textarea()} rows={4} class="mt-2 w-full resize-none rounded-2xl border border-night/12 bg-white px-4 py-3.5" /><FieldError field={requests} /></div>
        <label class="flex items-start gap-3 rounded-2xl bg-skywash p-4 text-sm leading-6"><input {...accepted.checkbox()} class="mt-1 size-4 accent-ocean" /><span>I agree to the booking terms and cancellation policy.</span></label>
        <FieldError field={accepted} />
        <div class="mt-2 flex justify-between gap-4">
          <button class="rounded-full border border-night/15 px-6 py-3 font-semibold" type="button" onClick={() => { step.value = 2; }}>Back</button>
          <button class="rounded-full bg-coral px-7 py-3 font-bold text-night disabled:opacity-50" type="submit" disabled={guest.pending.value} agentId="confirm-booking" agentAction="booking.confirm">{guest.pending.value ? "Confirming…" : `Confirm · ${money(total.value)}`}</button>
        </div>
      </form>
    </section>
  );
}

function ConfirmationStep() {
  return (
    <section hidden={() => step.value !== 4} class="py-8 text-center">
      <div class="mx-auto grid size-20 place-items-center rounded-full bg-ocean text-4xl text-white">✓</div>
      <p class="mt-7 text-xs font-black uppercase tracking-[.22em] text-ocean">You’re going to {search.values.value.destination}</p>
      <h1 class="mt-3 text-4xl font-semibold tracking-[-.04em] sm:text-5xl">Your room is waiting.</h1>
      <p class="mx-auto mt-4 max-w-lg leading-7 text-night/55">We sent the complete itinerary and flexible cancellation details to {guest.values.value.email}.</p>
      <div class="mx-auto mt-8 max-w-md rounded-3xl bg-white p-6 text-left shadow-sm">
        <div class="flex justify-between"><span class="text-night/45">Confirmation</span><strong>{confirmation.value}</strong></div>
        <div class="mt-3 flex justify-between"><span class="text-night/45">Stay</span><strong>{nights.value} nights · {room.value.name}</strong></div>
        <div class="mt-3 flex justify-between"><span class="text-night/45">Total</span><strong>{money(total.value)}</strong></div>
      </div>
      <button class="mt-8 rounded-full bg-night px-7 py-3 font-semibold text-white" onClick={() => { confirmation.value = ""; guest.reset(); step.value = 1; }}>Plan another stay</button>
    </section>
  );
}

function BookingSummary() {
  return (
    <aside class="rounded-[2rem] bg-night p-6 text-white lg:sticky lg:top-8 lg:self-start">
      <button {...details.trigger({ agentId: "toggle-booking-summary", agentLabel: "Toggle booking summary" })} class="flex w-full items-center justify-between text-left">
        <span><span class="block text-xs font-bold uppercase tracking-[.18em] text-white/45">Your stay</span><strong class="mt-1 block text-xl">{search.values.value.destination}</strong></span>
        <span class="text-xl">{details.open.value ? "−" : "+"}</span>
      </button>
      <div {...details.panel({ role: "region" })} class="mt-6">
        <div class={`aspect-[4/3] rounded-2xl bg-gradient-to-br ${room.value.tone}`} />
        <h2 class="mt-5 text-lg font-semibold">{room.value.name}</h2>
        <p class="mt-1 text-sm text-white/50">{readableDate(search.values.value.checkIn)} – {readableDate(search.values.value.checkOut)}</p>
        <dl class="mt-6 space-y-3 border-t border-white/10 pt-5 text-sm">
          <div class="flex justify-between"><dt class="text-white/50">{money(room.value.price)} × {nights.value} nights</dt><dd>{money(subtotal.value)}</dd></div>
          <div class="flex justify-between"><dt class="text-white/50">Service & local taxes</dt><dd>{money(service.value)}</dd></div>
          <div class="flex justify-between border-t border-white/10 pt-4 text-base font-bold"><dt>Total</dt><dd>{money(total.value)}</dd></div>
        </dl>
        <p class="mt-5 rounded-xl bg-white/6 p-3 text-xs leading-5 text-white/55">Free cancellation until 48 hours before check-in.</p>
      </div>
    </aside>
  );
}

function App() {
  return (
    <div class="min-h-screen">
      <header class="border-b border-night/8 bg-sand/90 backdrop-blur">
        <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <a href="#" class="text-xl font-black tracking-[-.04em]">ELSE<span class="text-ocean">WHERE</span></a>
          <span class="text-right text-[10px] font-semibold leading-4 text-night/45 sm:text-xs">Secure booking <span class="hidden sm:inline">· No account required</span></span>
        </div>
      </header>
      <main class="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:py-12">
        <Progress />
        <div class="mt-10 grid gap-10 lg:grid-cols-[1fr_22rem]">
          <div class="min-w-0">
            <SearchStep />
            <RoomStep />
            <GuestStep />
            <ConfirmationStep />
          </div>
          <BookingSummary />
        </div>
      </main>
    </div>
  );
}

render(document.querySelector("#app")!, <App />);
Object.assign(globalThis, { booking: { step, search, guest, selectedRoom, surface: createAgentSurface(document.querySelector("#app")!) } });
