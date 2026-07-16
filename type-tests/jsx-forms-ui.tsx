import {
  createDialog,
  createForm,
  createPagination,
  createTabs,
  s,
  signal,
} from "clank.run";

const newsletter = createForm({
  id: "newsletter",
  initial: {
    email: "",
    frequency: "weekly" as "daily" | "weekly",
    accepted: false,
  },
  schema: s.object({
    email: s.email(),
    frequency: s.enum(["daily", "weekly"]),
    accepted: s.literal(true),
  }),
  onSubmit: async (values) => values.email,
});

const email = newsletter.field("email");
const accepted = newsletter.field("accepted");
const text = signal("");

const formView = (
  <form {...newsletter.props()}>
    <label for={email.id}>Email</label>
    <input {...email.input({ type: "email" })} />
    <input bind:value={text} />
    <input {...accepted.checkbox()} />
    <button type="submit" onClick={(event) => event.currentTarget.form?.checkValidity()}>
      Subscribe
    </button>
  </form>
);

newsletter.setValue("email", "person@example.com");
// @ts-expect-error email is a string field.
newsletter.setValue("email", 42);
// @ts-expect-error field names are inferred.
newsletter.field("missing");
// @ts-expect-error checkbox props require a boolean field.
email.checkbox();

const dialog = createDialog({ id: "invite-dialog" });
const tabs = createTabs({
  id: "settings",
  tabs: [{ value: "profile" }, { value: "billing" }] as const,
});
const pagination = createPagination({ total: 100, pageSize: 20 });
dialog.show();
tabs.select("billing");
// @ts-expect-error tab values are inferred.
tabs.select("missing");
pagination.setPage(2);

// @ts-expect-error native tag typos are rejected while hyphenated custom elements remain supported.
const typo = <dvi />;
const customElement = <clank-chart data-series="revenue" />;

void formView;
void typo;
void customElement;
