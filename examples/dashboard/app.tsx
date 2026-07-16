import {
  For,
  Show,
  computed,
  createAgentSurface,
  createDialog,
  createForm,
  createPagination,
  createTabs,
  render,
  s,
  signal,
  type FormField,
} from "/dist/index.js";

type MemberStatus = "active" | "invited" | "suspended";

interface Member {
  id: string;
  name: string;
  email: string;
  role: "Owner" | "Admin" | "Editor" | "Viewer";
  status: MemberStatus;
  activity: string;
}

const names = [
  "Maya Chen", "Noah Williams", "Olivia Martin", "Liam Patel", "Ava Thompson", "Ethan Garcia",
  "Sophia Kim", "Lucas Brown", "Isabella Davis", "Mason Wilson", "Mia Anderson", "Elijah Moore",
  "Amelia Taylor", "James Jackson", "Harper White", "Benjamin Harris", "Evelyn Clark", "Henry Lewis",
  "Abigail Young", "Alexander Hall", "Emily Walker", "Daniel Allen", "Ella King", "Sebastian Wright",
];
const members = signal<Member[]>(names.map((name, index) => ({
  id: `member-${index + 1}`,
  name,
  email: `${name.toLowerCase().replace(" ", ".")}@relay.team`,
  role: index === 0 ? "Owner" : index % 5 === 0 ? "Admin" : index % 3 === 0 ? "Viewer" : "Editor",
  status: index % 11 === 0 ? "suspended" : index % 7 === 0 ? "invited" : "active",
  activity: index < 3 ? "Just now" : index < 9 ? `${index + 2} min ago` : `${(index % 8) + 1} days ago`,
})));

const section = createTabs({
  id: "admin-sections",
  tabs: [{ value: "overview" }, { value: "people" }, { value: "settings" }] as const,
});
const inviteDialog = createDialog({ id: "invite-member" });
const search = signal("");
const statusFilter = signal<"all" | MemberStatus>("all");
const savedSettings = signal(false);

const filteredMembers = computed(() => {
  const term = search.value.trim().toLowerCase();
  return members.value.filter((member) =>
    (statusFilter.value === "all" || member.status === statusFilter.value)
    && (!term || `${member.name} ${member.email} ${member.role}`.toLowerCase().includes(term))
  );
});
const pagination = createPagination({ total: computed(() => filteredMembers.value.length), pageSize: 7 });
const visibleMembers = computed(() =>
  filteredMembers.value.slice(pagination.start.value - 1, pagination.end.value)
);

const invite = createForm({
  id: "invite",
  initial: {
    email: "",
    role: "Editor" as Member["role"],
    sendCopy: true,
  },
  schema: s.object({
    email: s.email({ max: 160 }),
    role: s.enum(["Owner", "Admin", "Editor", "Viewer"]),
    sendCopy: s.boolean(),
  }),
  validateOn: "blur",
  resetOnSuccess: true,
  onSubmit: async (values, { signal: abortSignal, setErrors }) => {
    if (members.peek().some((member) => member.email === values.email.toLowerCase())) {
      setErrors({ email: "That person already belongs to this workspace." });
      return;
    }
    await pause(350, abortSignal);
    const local = values.email.split("@")[0]!.replace(/[._-]+/g, " ");
    const name = local.replace(/\b\w/g, (letter) => letter.toUpperCase());
    members.update((current) => [{
      id: crypto.randomUUID(),
      name,
      email: values.email.toLowerCase(),
      role: values.role,
      status: "invited",
      activity: "Invitation sent",
    }, ...current]);
    inviteDialog.hide();
  },
});

const settings = createForm({
  id: "workspace-settings",
  initial: {
    workspace: "Relay Product Studio",
    seats: 30,
    digest: true,
    securityAlerts: true,
  },
  schema: s.object({
    workspace: s.string({ min: 2, max: 80 }),
    seats: s.number({ integer: true, min: 1, max: 500 }),
    digest: s.boolean(),
    securityAlerts: s.boolean(),
  }),
  validateOn: "blur",
  onSubmit: async (_values, { signal: abortSignal }) => {
    await pause(300, abortSignal);
    savedSettings.value = true;
    setTimeout(() => { savedSettings.value = false; }, 2500);
  },
});

function pause(milliseconds: number, abortSignal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    abortSignal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortSignal.reason);
    }, { once: true });
  });
}

function FieldError<Value>({ field }: { field: FormField<Value> }) {
  return <p {...field.error()} class="mt-1 text-xs font-medium text-red-600">{field.message.value}</p>;
}

function SideNavigation() {
  const links = [
    { value: "overview" as const, label: "Overview", glyph: "⌁" },
    { value: "people" as const, label: "People", glyph: "◎" },
    { value: "settings" as const, label: "Settings", glyph: "⚙" },
  ];
  return (
    <aside class="border-b border-white/10 bg-navy p-5 text-white lg:fixed lg:inset-y-0 lg:w-64 lg:border-b-0 lg:border-r">
      <div class="flex items-center justify-between lg:block">
        <div class="flex items-center gap-3">
          <div class="grid size-10 place-items-center rounded-xl bg-electric font-black">R</div>
          <div><strong class="block">Relay</strong><span class="text-xs text-white/50">Product Studio</span></div>
        </div>
        <span class="rounded-full bg-white/8 px-2.5 py-1 text-xs text-white/60">PRO</span>
      </div>
      <nav {...section.list()} class="mt-0 grid grid-cols-3 gap-2 lg:mt-10 lg:block lg:space-y-2" aria-label="Admin sections">
        <For each={links} by="value">
          {(link) => (
            <button
              {...section.tab(link.value)}
              class="flex items-center justify-center gap-2 rounded-xl px-2 py-3 text-sm font-semibold text-white/60 transition hover:bg-white/8 hover:text-white lg:w-full lg:justify-start lg:gap-3 lg:px-4"
              classList={{ "bg-white/10 text-white": section.selected.value === link.value }}
              agentId={`nav-${link.value}`}
              agentLabel={`Open ${link.label}`}
            >
              <span class="text-lg">{link.glyph}</span>{link.label}
            </button>
          )}
        </For>
      </nav>
      <div class="mt-10 hidden rounded-2xl bg-white/6 p-4 lg:block">
        <p class="text-xs font-bold uppercase tracking-[.18em] text-white/40">Monthly usage</p>
        <div class="mt-3 h-2 overflow-hidden rounded-full bg-white/10"><div class="h-full w-[68%] rounded-full bg-electric" /></div>
        <p class="mt-2 text-xs text-white/50">6,802 of 10,000 events</p>
      </div>
    </aside>
  );
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return (
    <article class="rounded-2xl border border-black/6 bg-white p-5 shadow-sm">
      <div class={`mb-5 size-2.5 rounded-full ${tone}`} />
      <p class="text-sm text-black/50">{label}</p>
      <strong class="mt-1 block text-3xl tracking-[-.04em]">{value}</strong>
      <p class="mt-3 text-xs font-medium text-emerald-600">{detail}</p>
    </article>
  );
}

function Overview() {
  const activity = [
    ["MC", "Maya published “Summer launch”", "2 min"],
    ["NW", "Noah invited 3 collaborators", "18 min"],
    ["OM", "Olivia exported the July report", "1 hr"],
    ["LP", "Liam changed workspace permissions", "3 hr"],
  ];
  const bars = [44, 62, 48, 78, 66, 91, 84, 58, 72, 88, 76, 96];
  return (
    <section {...section.panel("overview")}>
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Active projects" value="24" detail="↑ 12% this month" tone="bg-electric" />
        <MetricCard label="Team members" value={String(members.value.length)} detail="↑ 4 new invitations" tone="bg-emerald-500" />
        <MetricCard label="Automations run" value="6,802" detail="↑ 18% from June" tone="bg-amber-400" />
        <MetricCard label="Success rate" value="99.7%" detail="All systems healthy" tone="bg-sky-400" />
      </div>
      <div class="mt-5 grid gap-5 xl:grid-cols-[1.45fr_.75fr]">
        <article class="rounded-2xl border border-black/6 bg-white p-6 shadow-sm">
          <div class="flex items-start justify-between">
            <div><h2 class="text-lg font-semibold">Workspace activity</h2><p class="mt-1 text-sm text-black/45">Events completed over the last 12 weeks</p></div>
            <span class="rounded-lg bg-lilac px-3 py-1.5 text-xs font-semibold text-electric">Last 12 weeks</span>
          </div>
          <div class="mt-10 flex h-64 items-end gap-2" aria-label="Activity chart">
            <For each={bars}>
              {(height, index) => <div class="flex-1 rounded-t-lg bg-electric/15 transition hover:bg-electric" style={{ height: `${height}%` }} title={`Week ${index() + 1}: ${height} events`} />}
            </For>
          </div>
          <div class="mt-3 flex justify-between text-[10px] uppercase tracking-wider text-black/35"><span>May</span><span>June</span><span>July</span></div>
        </article>
        <article class="rounded-2xl border border-black/6 bg-white p-6 shadow-sm">
          <h2 class="text-lg font-semibold">Recent activity</h2>
          <div class="mt-5 space-y-5">
            <For each={activity}>
              {(entry) => (
                <div class="flex gap-3">
                  <div class="grid size-9 shrink-0 place-items-center rounded-full bg-lilac text-xs font-bold text-electric">{entry[0]}</div>
                  <div class="min-w-0 flex-1"><p class="text-sm leading-5">{entry[1]}</p><span class="text-xs text-black/40">{entry[2]} ago</span></div>
                </div>
              )}
            </For>
          </div>
        </article>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: MemberStatus }) {
  const styles = status === "active"
    ? "bg-emerald-50 text-emerald-700"
    : status === "invited"
      ? "bg-amber-50 text-amber-700"
      : "bg-red-50 text-red-700";
  return <span class={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${styles}`}>{status}</span>;
}

function People() {
  return (
    <section {...section.panel("people")}>
      <div class="rounded-2xl border border-black/6 bg-white shadow-sm">
        <div class="flex flex-col gap-4 border-b border-black/6 p-5 lg:flex-row lg:items-center">
          <div class="flex-1"><h2 class="text-lg font-semibold">People</h2><p class="text-sm text-black/45">Manage access, roles, and invitations.</p></div>
          <input class="rounded-xl border border-black/10 px-4 py-2.5 text-sm" placeholder="Search people…" bind:value={search} id="member-search" name="search" />
          <select class="rounded-xl border border-black/10 bg-white px-4 py-2.5 text-sm" bind:value={statusFilter} id="status-filter" aria-label="Filter member status">
            <option value="all">All statuses</option><option value="active">Active</option><option value="invited">Invited</option><option value="suspended">Suspended</option>
          </select>
          <button {...inviteDialog.trigger({ agentId: "invite-member", agentLabel: "Invite a team member" })} class="rounded-xl bg-electric px-4 py-2.5 text-sm font-semibold text-white">Invite member</button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[720px] text-left text-sm">
            <thead class="bg-cloud text-xs uppercase tracking-wider text-black/40"><tr><th class="px-5 py-3">Member</th><th class="px-5 py-3">Role</th><th class="px-5 py-3">Status</th><th class="px-5 py-3">Last activity</th><th class="px-5 py-3"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody class="divide-y divide-black/6">
              <For each={visibleMembers.value} by="id" fallback={<tr><td colspan={5} class="p-12 text-center text-black/45">No people match those filters.</td></tr>}>
                {(member) => (
                  <tr>
                    <td class="px-5 py-4"><div class="font-semibold">{member.name}</div><div class="text-xs text-black/45">{member.email}</div></td>
                    <td class="px-5 py-4">{member.role}</td>
                    <td class="px-5 py-4"><StatusBadge status={member.status} /></td>
                    <td class="px-5 py-4 text-black/50">{member.activity}</td>
                    <td class="px-5 py-4 text-right"><button class="rounded-lg px-3 py-1.5 text-black/45 hover:bg-cloud hover:text-navy" agentId={`member-${member.id}-menu`} agentLabel={`Open actions for ${member.name}`}>•••</button></td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <footer class="flex flex-col gap-3 border-t border-black/6 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-xs text-black/45">Showing {pagination.start.value}–{pagination.end.value} of {pagination.total.value}</p>
          <nav class="flex items-center gap-1" aria-label="Member pages">
            <button class="rounded-lg px-3 py-2 text-sm disabled:opacity-30" disabled={!pagination.canPrevious.value} onClick={pagination.previous}>Previous</button>
            <For each={pagination.pages.value}>
              {(page) => page === "ellipsis"
                ? <span class="px-2 text-black/35">…</span>
                : <button class="grid size-9 place-items-center rounded-lg text-sm" classList={{ "bg-navy text-white": pagination.page.value === page }} onClick={() => pagination.setPage(page)}>{page}</button>
              }
            </For>
            <button class="rounded-lg px-3 py-2 text-sm disabled:opacity-30" disabled={!pagination.canNext.value} onClick={pagination.next}>Next</button>
          </nav>
        </footer>
      </div>
    </section>
  );
}

function Settings() {
  const workspace = settings.field("workspace");
  const seats = settings.field("seats");
  const digest = settings.field("digest");
  const securityAlerts = settings.field("securityAlerts");
  return (
    <section {...section.panel("settings")} class="max-w-3xl">
      <form {...settings.props()} class="rounded-2xl border border-black/6 bg-white shadow-sm">
        <div class="border-b border-black/6 p-6"><h2 class="text-lg font-semibold">Workspace settings</h2><p class="mt-1 text-sm text-black/45">General details and notification preferences.</p></div>
        <div class="space-y-6 p-6">
          <div><label class="text-sm font-semibold" for={workspace.id}>Workspace name</label><input {...workspace.input()} class="mt-2 w-full rounded-xl border border-black/10 px-4 py-3" /><FieldError field={workspace} /></div>
          <div><label class="text-sm font-semibold" for={seats.id}>Seat limit</label><input {...seats.input({ type: "number" })} min={1} max={500} class="mt-2 w-full rounded-xl border border-black/10 px-4 py-3" /><FieldError field={seats} /></div>
          <div class="space-y-3 border-t border-black/6 pt-6">
            <label class="flex items-center justify-between gap-5 rounded-xl bg-cloud p-4"><span><strong class="block text-sm">Weekly digest</strong><span class="text-xs text-black/45">A concise workspace summary each Monday.</span></span><input {...digest.checkbox()} class="size-5 accent-electric" /></label>
            <label class="flex items-center justify-between gap-5 rounded-xl bg-cloud p-4"><span><strong class="block text-sm">Security alerts</strong><span class="text-xs text-black/45">Important access and permission changes.</span></span><input {...securityAlerts.checkbox()} class="size-5 accent-electric" /></label>
          </div>
        </div>
        <footer class="flex items-center justify-end gap-4 border-t border-black/6 p-5">
          <span class="text-sm font-medium text-emerald-600" hidden={() => !savedSettings.value}>Settings saved.</span>
          <button class="rounded-xl bg-navy px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50" type="submit" disabled={settings.pending.value || !settings.dirty.value}>{settings.pending.value ? "Saving…" : "Save changes"}</button>
        </footer>
      </form>
    </section>
  );
}

function InviteDialog() {
  const email = invite.field("email");
  const role = invite.field("role");
  const sendCopy = invite.field("sendCopy");
  return (
    <>
      <div {...inviteDialog.backdrop()} class="fixed inset-0 z-40 bg-navy/40 backdrop-blur-sm" />
      <section {...inviteDialog.dialog()} class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-7 shadow-2xl">
        <div class="flex items-start justify-between gap-5">
          <div><h2 {...inviteDialog.title()} class="text-2xl font-semibold">Invite a teammate</h2><p {...inviteDialog.description()} class="mt-2 text-sm text-black/50">They’ll receive a secure link to join Relay Product Studio.</p></div>
          <button class="grid size-10 place-items-center rounded-full bg-cloud text-xl" onClick={inviteDialog.hide} agentLabel="Close invite dialog">×</button>
        </div>
        <form {...invite.props()} class="mt-7 space-y-5">
          <div><label class="text-sm font-semibold" for={email.id}>Work email</label><input {...email.input({ type: "email" })} autocomplete="email" class="mt-2 w-full rounded-xl border border-black/10 px-4 py-3 focus:border-electric" /><FieldError field={email} /></div>
          <div><label class="text-sm font-semibold" for={role.id}>Role</label><select {...role.select()} class="mt-2 w-full rounded-xl border border-black/10 bg-white px-4 py-3"><option>Admin</option><option>Editor</option><option>Viewer</option></select><FieldError field={role} /></div>
          <label class="flex items-center gap-3 text-sm"><input {...sendCopy.checkbox()} class="size-4 accent-electric" />Send me a copy of the invitation</label>
          <button class="w-full rounded-xl bg-electric px-5 py-3 font-semibold text-white disabled:opacity-50" disabled={invite.pending.value} type="submit" agentId="send-invitation" agentAction="members.invite">{invite.pending.value ? "Sending invitation…" : "Send invitation"}</button>
        </form>
      </section>
    </>
  );
}

function App() {
  return (
    <div class="min-h-screen">
      <SideNavigation />
      <main class="lg:ml-64">
        <header class="flex items-center justify-between border-b border-black/6 bg-white px-5 py-5 sm:px-8">
          <div><p class="text-xs font-bold uppercase tracking-[.18em] text-electric">Workspace</p><h1 class="mt-1 text-2xl font-semibold capitalize">{section.selected.value}</h1></div>
          <div class="flex items-center gap-3"><button class="grid size-10 place-items-center rounded-full bg-cloud" aria-label="Notifications">◌</button><div class="grid size-10 place-items-center rounded-full bg-navy text-xs font-bold text-white">MC</div></div>
        </header>
        <div class="p-5 sm:p-8">
          <Overview />
          <People />
          <Settings />
        </div>
      </main>
      <InviteDialog />
    </div>
  );
}

render(document.querySelector("#app")!, <App />);
Object.assign(globalThis, { dashboard: { members, invite, settings, pagination, surface: createAgentSurface(document.querySelector("#app")!) } });
