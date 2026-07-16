# Headless UI behavior

Clank provides small state machines for behavior that is deceptively difficult to implement correctly. They return ordinary HTML props and directives rather than styled components, so Tailwind and application markup remain fully under your control.

## Disclosure

Use one disclosure for an accordion item, filter panel, navigation drawer, or expandable summary:

```tsx
const filters = createDisclosure({
  id: "product-filters",
  initialOpen: false,
});

<button {...filters.trigger()}>Filters</button>
<section {...filters.panel({ role: "region" })}>
  Filter controls
</section>
```

The trigger receives `aria-controls`, a reactive boolean `aria-expanded`, native button type, and disabled state. The panel receives a deterministic ID, label relationship, and reactive `hidden`.

Methods are `show()`, `hide()`, and `toggle()`.

## Modal dialog

```tsx
const invite = createDialog({ id: "invite-dialog" });

<button {...invite.trigger()}>Invite teammate</button>
<div {...invite.backdrop()} class="fixed inset-0 bg-black/40" />
<section {...invite.dialog()} class="fixed rounded-2xl bg-white">
  <h2 {...invite.title()}>Invite teammate</h2>
  <p {...invite.description()}>Send a secure workspace invitation.</p>
  <button onClick={invite.hide}>Close</button>
</section>
```

The dialog behavior includes:

- `role="dialog"` and `aria-modal="true"`;
- deterministic title and description relationships;
- initial focus on the first usable control;
- Tab and Shift+Tab focus wrapping;
- Escape dismissal;
- optional backdrop dismissal;
- body scroll locking;
- focus restoration to the opening control.

Configure `closeOnEscape`, `closeOnBackdrop`, `restoreFocus`, and `lockScroll` when a workflow needs different behavior.

The dialog does not impose a portal. Place its markup where it is structurally understandable and use CSS positioning when it should visually escape the page flow.

## Tabs

```tsx
const settings = createTabs({
  id: "settings",
  tabs: [
    { value: "profile" },
    { value: "billing" },
    { value: "danger", disabled: true },
  ] as const,
});

<nav {...settings.list()}>
  <button {...settings.tab("profile")}>Profile</button>
  <button {...settings.tab("billing")}>Billing</button>
</nav>

<section {...settings.panel("profile")}>…</section>
<section {...settings.panel("billing")}>…</section>
```

Tabs provide roles, selection state, roving tab index, panel relationships, disabled state, and keyboard navigation:

- horizontal: Left/Right;
- vertical: Up/Down;
- Home/End;
- Enter/Space in manual activation mode.

Tab values are inferred by TypeScript and must produce unique DOM-safe IDs.

## Pagination

```tsx
const page = createPagination({
  total: computed(() => filteredRows.value.length),
  pageSize: 20,
  siblingCount: 1,
});

const visible = computed(() =>
  filteredRows.value.slice(page.start.value - 1, page.end.value)
);
```

The controller exposes `page`, `pageSize`, `total`, `pageCount`, `start`, `end`, `canPrevious`, `canNext`, and a compact `pages` array containing page numbers and `"ellipsis"`.

Methods are `setPage`, `setPageSize`, `previous`, `next`, and `dispose`. Changing totals automatically clamps the active page.

## Directives

`clickOutside(handler)` listens for captured pointer activity outside an element:

```tsx
<div use={clickOutside(() => menu.hide())}>…</div>
```

`autoFocus` focuses a connected element in the next microtask:

```tsx
<input use={autoFocus} />
```

Directives return cleanup functions and are disposed with their component.

## Accessibility rules

Headless helpers make the relationships correct, but application markup still matters:

- use visible labels for form controls;
- preserve meaningful heading order;
- do not make noninteractive elements clickable;
- keep focus indicators visible;
- use `agentLabel` when the visible name is ambiguous, not as a substitute for human text;
- test keyboard operation and narrow viewports.

Boolean ARIA states are emitted explicitly as `"true"` and `"false"` in both DOM rendering and SSR.
