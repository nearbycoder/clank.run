# Headless UI

Clank includes a dependency-free headless UI library aligned to the complete 37-family
[Base UI 1.6 component catalog](https://base-ui.com/react/components). The implementation records
`BASE_UI_REFERENCE_VERSION` as `1.6.0`, and every catalog record links to the corresponding
upstream anatomy page. The API is intentionally Clank-native rather than a React or Base UI
drop-in: factories return reactive controllers and ordinary DOM prop getters instead of React
components.

The library owns state transitions, ARIA relationships, keyboard behavior, focus, form projection, presence, and positioning. Your application owns the elements, content, Tailwind classes, and visual design.

## What dependency-free means

The UI runtime is part of `@clank.run/framework` and adds no package dependencies. It does not load Base UI, React, Floating UI, a focus-trap package, or a CSS-in-JS runtime. It uses Clank's reactive core plus browser and web-platform APIs such as DOM events, `Intl`, `FormData`, `ResizeObserver`, and Pointer Events.

Tailwind remains optional application build tooling. Clank emits ordinary classes, attributes,
styles, and CSS custom properties, so it needs no Tailwind plugin. The controllers ship no visual
CSS; the optional typed preset layer at `@clank.run/framework/ui/theme` provides design tokens
without changing component markup or behavior. Inspect it at
[design.clank.run](https://design.clank.run) or read the [design-system guide](design-system.md).

## Imports

Import UI factories with the rest of the framework:

```tsx
import {
  Portal,
  Show,
  createCheckbox,
  createDialog,
  createSwitch,
  mergeProps,
  onMount,
  useId,
} from "@clank.run/framework";
```

Or use the focused UI entry point and import renderer primitives separately:

```tsx
import { Portal, onMount, useId } from "@clank.run/framework/dom";
import {
  createCheckbox,
  createDialog,
  createSwitch,
  mergeProps,
} from "@clank.run/framework/ui";
```

Both package entry points expose the same catalog factories. The `/ui` entry point omits unrelated server, database, and deployment APIs.

Group-level and per-family subpaths are also public. They make generated code and agent plans
explicit; each family path resolves to the corresponding dependency-free group module:

```ts
import { createDialog } from "@clank.run/framework/ui/dialog";
import { createMenu, createToolbar } from "@clank.run/framework/ui/collections";
import { UI_COMPONENT_CATALOG } from "@clank.run/framework/ui/catalog";
```

Every catalog slug in the table below has a matching `@clank.run/framework/ui/<slug>` path.
Foundation, composition, overlay, popups, controls, selection, collections, fields, utilities,
catalog, and legacy group paths are available as well. The root package also re-exports the UI
surface; use `/ui` or a focused subpath when import intent matters. Family paths are stable typed
aliases to six category modules, not 37 symbol-isolated bundles, so a namespace import from
`/ui/button` can also see neighboring control exports.

## The controller and part model

Create one controller for one logical component. Each part getter returns the props for a semantic element:

```tsx
function NotificationsSetting() {
  const notifications = createSwitch({
    id: useId("notifications"),
    name: "notifications",
    defaultChecked: true,
  });

  return (
    <div>
      <button
        {...notifications.root({ nativeButton: true, agentLabel: "Email notifications" })}
        aria-label="Email notifications"
        class="relative h-6 w-11 rounded-full bg-slate-300 data-[checked]:bg-emerald-500"
      >
        <span
          {...notifications.thumb()}
          class="block size-5 translate-x-0.5 rounded-full bg-white transition data-[checked]:translate-x-5"
        />
      </button>
      <input {...notifications.input()} class="sr-only" />
    </div>
  );
}
```

This example has three distinct layers:

- `createSwitch()` owns the checked state and transition rules.
- `root()`, `thumb()`, and `input()` provide DOM behavior for the parts.
- the application supplies markup, text, and Tailwind classes.

Part objects may contain static DOM props, reactive accessor functions, event handlers, callback
refs, a `use` directive, data attributes, and CSS variables. Spread the complete object onto the
intended element. Clank resolves reactive accessors without replacing that element.

The catalog's `parts` array is the canonical Base UI-aligned anatomy used by generators and
conformance tests. A controller can expose additional shared methods, compatibility aliases, or
native-projection helpers. For example, `createDialog()` retains `popup()` and the clearer
`dialog()` alias, while the catalog records only `popup`; `createCombobox().hiddenInputs()` creates
the native controls represented by the catalog's `form-control` and `hidden-input` parts.

Prefer the native element described by a component's manifest. Some controls make custom elements keyboard-operable, but a native `button`, `input`, `fieldset`, `form`, or link preserves more browser behavior with less work.

### Compose rather than overwrite

Use `mergeProps()` when application props and headless props both contain handlers, refs, classes, styles, or ARIA relationships:

```tsx
const props = mergeProps(
  {
    onClick(event: MouseEvent) {
      if (!mayEdit.value) event.preventDefault();
    },
  },
  toggle.root({ agentLabel: "Bold" }),
  {
    class: "rounded-md px-3 py-2 data-[pressed]:bg-slate-900 data-[pressed]:text-white",
  },
);

return <button {...props}>Bold</button>;
```

Handlers run from left to right. A handler can stop the later handlers by calling `preventDefault()`, using structured cancellation, or returning `false`. `mergeProps()` also merges class values, style objects, token-list ARIA attributes, and refs without discarding required internal behavior.

For reusable wrappers, `renderPart()` composes the headless props with a default tag, an existing VNode, or a render function:

```tsx
return renderPart({
  defaultTag: "button",
  props: toggle.root(),
  render: props.render,
  state: { pressed: toggle.pressed.value },
  children: props.children,
});
```

## Controlled and uncontrolled state

Stateful factories follow one convention:

- `defaultOpen`, `defaultValue`, `defaultChecked`, or `defaultPressed` creates uncontrolled state.
- `open`, `value`, `checked`, or `pressed` creates controlled state. Pass a reactive getter when the value can change.
- `onOpenChange`, `onValueChange`, `onCheckedChange`, or `onPressedChange` receives the requested value and a `ChangeDetails` object.
- controller setters return `true` only when a different transition was accepted.

In controlled mode, Clank reports a request but never mutates the external value:

```tsx
const open = signal(false);

const popover = createPopover({
  id: "account-actions",
  open: () => open.value,
  onOpenChange(next, details) {
    if (next && accountLocked.value) {
      details.cancel();
      return;
    }
    open.value = next;
  },
});
```

`ChangeDetails` contains `reason`, the optional originating `event`, `canceled`, and `cancel()`. Calling `details.cancel()` prevents an uncontrolled write. A native event that was already default-prevented also cancels its transition. Reasons such as `trigger-press`, `keyboard`, `outside-press`, `reset`, and `programmatic` let application and agent code distinguish intent without parsing DOM events.

The same cancellation rule applies to button presses, menu actions, field changes, commits, and form submission. Cancellation only governs the headless default transition; application callbacks remain responsible for their own domain side effects.

## Tailwind and state attributes

Clank controllers have no visual CSS. Style the exact markup your product needs using ordinary
`class` values, optionally backed by the package's typed theme variables:

```tsx
<button
  {...checkbox.root({ nativeButton: true })}
  aria-label="Include archived projects"
  class={[
    "grid size-5 place-items-center rounded border transition",
    "data-[checked]:border-indigo-600 data-[checked]:bg-indigo-600",
    "data-[indeterminate]:border-indigo-600 data-[indeterminate]:bg-indigo-100",
    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
  ].join(" ")}
>
  <span {...checkbox.indicator()}>✓</span>
</button>
```

Checkbox, Checkbox Group item, Radio item, and Switch roots default to the Base UI
wrapping-label-friendly `span` contract. They include custom-control focus and keyboard props while
their visually hidden native inputs handle submission and validation. When you render one of those
roots as an actual `<button>`, pass `{ nativeButton: true }` as above; this supplies `type="button"`
and native disabled behavior without duplicating keyboard activation. The built-in input projection
already includes the required visually-hidden mechanics, so a styling class is optional.

Depending on the family and part, the library exposes hooks including:

| Hook | Meaning |
| --- | --- |
| `data-clank-part` | Stable semantic part name when that family emits it. |
| `data-open`, `data-closed` | Open and closed disclosure or popup state. |
| `data-checked`, `data-unchecked`, `data-indeterminate` | Binary or tri-state controls. |
| `data-selected`, `data-highlighted`, `data-active`, `data-pressed` | Collection, selection, navigation, and toggle state. |
| `data-disabled`, `data-readonly`, `data-required` | Interaction constraints. |
| `data-valid`, `data-invalid`, `data-dirty`, `data-touched`, `data-filled`, `data-pending` | Field and form state. |
| `data-orientation`, `data-side`, `data-align` | Logical layout and resolved floating placement. |
| `data-starting-style`, `data-ending-style` | Presence phases for CSS entry and exit transitions. |

Positioned and measured families expose values such as `--clank-anchor-width`, `--clank-available-height`, `--clank-slider-percentage`, `--clank-progress-percentage`, `--clank-tabs-indicator-left`, `--clank-scroll-area-thumb-size`, `--clank-toast-offset`, and `--clank-drawer-drag-offset`. Treat these as inputs to your CSS; they do not impose a theme.

Some utility families use purpose-specific hooks such as `data-toast-action` rather than `data-clank-part`. Inspect the returned part type or `manifest()` instead of assuming every family emits every common attribute.

Keep utility classes statically discoverable by your Tailwind build, or safelist classes assembled
from runtime data. Controllers never inject a theme or visual stylesheet. The optional theme API
only emits CSS when your build calls `createClankThemeStylesheet()` or applies variables when your
code explicitly calls `applyClankTheme()`. Controllers do write element-level
style properties and CSS custom properties for measured primitives such as floating content,
sliders, drawers, tabs, scroll areas, and toasts. The one behavioral stylesheet is a tiny
document-deduplicated Scroll Area rule that hides Chromium/Safari's native scrollbar pseudo-element
while a custom viewport is mounted; it is removed after the final viewport unmounts.

`CSPProvider` validates and exposes a nonce through `useCspNonce()` for application-owned
`<style>` or stylesheet integrations and for that Scroll Area behavioral rule. A nonce does **not**
authorize element `style` attributes under CSP. If your policy sets
`style-src-attr 'none'`, the measured primitives' built-in positioning and CSS-variable props will
be blocked unless you adapt those values to a policy-compatible stylesheet. No headless API uses
`eval`, `Function`, or remote CSS.

## Server rendering, hydration, and portals

Controllers are SSR-safe. Event listeners, DOM measurement, focus, timers that require mounted elements, and `use` directives attach only in the browser. The server and client must still create the same controller tree with the same initial state.

Use `useId()` when an ID belongs to a rendered component. It generates the same request-local sequence during SSR and hydration:

```tsx
function DeleteProjectDialog() {
  const dialog = createAlertDialog({ id: useId("delete-project") });

  onMount(() => dialog.dispose);

  return (
    <>
      <button {...dialog.trigger()}>Delete project</button>

      <Show when={dialog.isMounted}>
        <Portal target="#overlays">
          <div {...dialog.portal()}>
            <div
              {...dialog.backdrop()}
              class="fixed inset-0 bg-black/50 data-[closed]:hidden data-[starting-style]:opacity-0"
            />
            <section
              {...dialog.dialog()}
              class="fixed left-1/2 top-1/2 w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl"
            >
              <h2 {...dialog.title()}>Delete this project?</h2>
              <p {...dialog.description()}>This action cannot be undone.</p>
              <button {...dialog.close()}>Cancel</button>
              <button type="button">Delete</button>
            </section>
          </div>
        </Portal>
      </Show>
    </>
  );
}
```

During SSR, `Portal` leaves the content at its declaration site between hydration markers. Hydration attaches ownership and then moves it to the target without losing context, events, or cleanup. A portal target can be an element, document fragment, selector, or lazy getter; it must belong to the same document as the render root. Omitting `target` uses that document's body.

Popup factories are portal-ready but do not force a portal. For anchored families, place `popup()`
and `arrow()` inside `positioner()`. Dialogs and alert dialogs are not anchored and do not need a
positioner wrapper.

Every popup-backed controller exposes `isMounted({ keepMounted? })` and
`portal({ keepMounted? })`. A default-closed popup returns `false` from `isMounted()`, becomes
mounted while open, and remains mounted through its ending transition. After the transition it can
leave the tree. Factory-level `keepMounted: true`, or the same per-portal option, keeps the closed
content in the tree; `portal().hidden()` then hides it. Use `isMounted` as the renderer condition and
spread the matching `portal()` props on an application-owned wrapper inside `Portal`, as above.
Select, Combobox, and Autocomplete proxy this same presence contract.

Collapsible uses `isPanelMounted(options)` with the same retained-exit and `keepMounted` behavior,
plus `hiddenUntilFound`. Accordion and Tabs use `isPanelMounted(value, options)` because each value
has independent panel presence. Pass the same options to the corresponding `panel()` getter.

`createFloating()` uses fixed positioning by default, supports side and logical alignment offsets, flips and shifts at viewport collisions, updates on resize and captured scroll, and exposes resolved placement and arrow coordinates. `createPresence()` retains an ending element through its CSS transition or animation, with a timeout fallback.

`createFloating()` is a deliberately bounded platform implementation, not a Floating UI middleware
clone. It measures one element or virtual anchor, flips to the opposite side when that side has
more room, shifts inside the visual viewport and clipping ancestors, and supports fixed or absolute
positioning. Complex polygon avoidance, arbitrary middleware chains, and cross-document anchors
are outside this API.

Hydration preserves matching elements and attaches the reactive accessors in part objects. A structural mismatch triggers Clank's documented remount fallback. Keep initial values, IDs, locale inputs, direction, and collection order deterministic to avoid that fallback. `createMediaQuery(query, defaultMatches)` renders the supplied default until the browser can attach the media query.

## Keyboard, focus, and accessibility

The controllers implement behavior, but application markup and copy still determine whether the finished interface is accessible.

- Keep every visible or programmatic control named with text, `<label>`, `aria-label`, or `aria-labelledby`. `agentLabel` helps agents; it is not an accessible-name substitute.
- Spread the entire part object. Removing a handler, ref, `use` directive, ID, or ARIA relationship can break keyboard operation or form synchronization.
- Preserve the recommended native element and meaningful document heading order.
- Keep visible focus indicators in your Tailwind classes.
- Render dialog titles and descriptions when the default relationships reference them, or explicitly pass `false` and supply another accessible relationship.
- A tooltip supplements a named trigger. It must not be the only accessible name or the only way to discover essential content.
- Test left-to-right and right-to-left layouts when a factory accepts `direction` or inherits it from an element.
- Test keyboard, pointer, touch, zoom, reduced motion, narrow viewports, and high-contrast modes in the completed application.

The shared overlay manager is scoped per owner document. Only the topmost layer handles Escape, outside presses, or focus dismissal. A modal layer traps Tab, restores focus, inerts outside body children, and reference-counts body scroll locking. `modal: "trap-focus"` traps focus without inerting the background; `modal: false` leaves normal document focus available.

Nonmodal Popover, Dialog, and Drawer close when focus leaves their trigger/popup boundary by
default. Set `closeOnFocusOutside` explicitly to override that behavior. Disabling pointer
dismissal also disables this inferred focus-out dismissal unless focus dismissal is explicitly
re-enabled.

The focus scope follows open shadow roots and includes registered overlay branches. If content that
logically belongs to a modal is portaled outside its popup subtree, spread
`overlay.branchProps()` on that detached root or register it with `overlay.branch(element)`. Branch
registration is reference-counted, participates in outside-event containment, and causes the
modal inert boundary to be recalculated when branches mount or unmount.

`overlay.branch(element, { interactionOnly: true })` is the narrower primitive for detached
triggers or anchors: it prevents an outside-press dismissal race without adding that background
control to the modal focus scope or exempting its ancestors from inerting. Popup controllers use
this automatically for every trigger.

A popup controller may have multiple triggers. Only the active trigger reports open/expanded.
Pressing, focusing, or hovering another trigger transfers the anchor without an intermediate
close; mounting another trigger while open does not steal ownership. Every mounted trigger remains
inside the popup's outside-event boundary. Abandoned pointer sequences cannot affect a later
keyboard, assistive-technology, or programmatic click.

Collection behavior is family-specific. Menus use roving focus and typeahead; Tab dismisses an open
menu without restoring its trigger so the browser can continue normal focus navigation. Tabs use
manual activation by default; toolbar and menubar are one document Tab stop; accordion triggers
remain in normal Tab order and intentionally do not capture arrow keys. A toolbar's reactive
`disabled` option removes every child from the roving Tab sequence and blocks controller presses.
Use the Base UI-compatible `loopFocus` option to control focus wrapping; `loop` remains an alias.
The catalog below records the important differences.

Accordion panel mounting is explicit because a prop getter cannot add or remove application
markup. `isPanelMounted(value, { keepMounted?, hiddenUntilFound? })` reports whether a renderer
should include that panel. Pass the same options to `panel(value, options)`. A closed
`keepMounted` panel receives `hidden`; a `hiddenUntilFound` panel receives
`hidden="until-found"` and opens through `beforematch`; otherwise the application can omit the
closed panel. The root-level `keepMounted` option remains as a deprecated default for existing
applications.

Navigation Menu labels its flyout popup from `popupLabel` when supplied, otherwise from the root
`label`. It never synthesizes an English “submenu” label. Supply `label`/`labelledBy` for the root
and `popupLabel` when the flyout needs a distinct accessible name. Hover and pointer opening do not
move document focus; moving focus outside the navigation closes the flyout. Link activation leaves
the flyout open by default, matching Base UI. Set `closeOnClick: true` on a link definition when
that link should explicitly dismiss it.

`createButton()` synthesizes the native keyboard contract only when the rendered element is not
already a native button: Enter activates on keydown, while Space
prevents page scrolling on keydown and activates on keyup. Prefer a real `<button>` so the browser
continues to own form submission, disabled semantics, and platform-specific activation.

### Direction and right-to-left layouts

Collection, slider, OTP, scroll-area, and drawer factories expose the direction controls relevant
to their geometry. With `direction: "auto"`, supported families resolve the nearest `dir`, then
computed/document direction, when handling a mounted element. Horizontal arrow movement and
logical alignment reverse where required; vertical semantics do not.

`DirectionProvider` and `UiProvider` expose context through `useDirection()`. Direction-aware
factories read that context when their `direction` option is omitted, so create them under the
provider during component evaluation. A controller deliberately created outside a component sees
the default `"ltr"` environment unless an explicit direction is passed. Selection and anchored
popup controllers accept explicit `"ltr"`/`"rtl"`; collection and field controllers that also type
`"auto"` can inherit from their mounted element. Test actual application markup in both
directions—custom CSS and item order remain application responsibilities.

### Scroll Area labels

`createScrollArea({ label, labelledBy })` can name the overall region. Each custom scrollbar is a
separate focusable `role="scrollbar"` control and is named independently. Horizontal and vertical
scrollbars default to “Horizontal scrollbar” and “Vertical scrollbar”; override with
`scrollbar(orientation, { label })`, or use `{ labelledBy }` to reference application text.
`labelledBy` takes precedence over `label`. A track with no overflow becomes hidden, leaves the Tab
sequence, and receives `aria-hidden`; the viewport continues to use native scrolling. Custom tracks
do not intercept Ctrl+wheel, preserving browser zoom. A mounted viewport receives
`data-clank-scroll-area-viewport`; Clank uses that hook for its nonce-aware, deduplicated WebKit
scrollbar-hiding rule.

### Nullable tabs

Tabs accept `value`, `defaultValue`, and `select()` values of `Value | null`. A `null` value leaves
every panel hidden and sets the indicator index to `-1`; the roving Tab stop still stays on an
enabled tab so keyboard users can select one. Disabled tabs may remain focusable in the roving
sequence for discoverability, but press and programmatic selection are rejected. In controlled
mode, `onValueChange` must update the external nullable value for the visual state to change.

### Select typeahead

When a single Select is closed, printable-key typeahead searches from the current selection and
commits the next matching enabled item without opening the popup. Closed multiple and read-only
Selects leave printable keys untouched because committing one match would be ambiguous. While
open, printable typeahead only moves the highlight until activation. Focus moving between trigger
and popup remains internal; an actual external blur or an accepted focus-out/outside-press
dismissal marks the Field touched and runs blur validation.

### Autocomplete completion

Combobox and Autocomplete accept `completionMode: "none" | "list" | "inline" | "both"`:

| Mode | Filtering/list suggestion | Inline suffix |
| --- | --- | --- |
| `none` | Declared items remain unfiltered | No |
| `list` | Filtered list and active-descendant navigation | No |
| `inline` | Filtered list | Yes |
| `both` | Filtered list and active-descendant navigation | Yes |

Inline mode paints the matching label suffix into the mounted input and selects only that suffix;
the controller's `inputValue` remains the text the user typed until acceptance. Tab or blur accepts
the suffix, Escape restores the typed text, and Enter accepts it when there is no separately
highlighted item. Combobox acceptance commits the declared item value; Autocomplete acceptance
updates its free-form `inputValue` without inventing a declared item value. Matching is
prefix-based and accent-insensitive. Controlled
`inputValue`/`value` callbacks must update their external sources just like every other controlled
controller.

Click behavior intentionally follows each family. Combobox defaults `openOnInputClick` to `true`,
so clicking even an empty editable input opens its list. Autocomplete defaults it to `false`; pass
`openOnInputClick: true` when click-to-browse is appropriate. Autocomplete also clears a pointer
highlight when the pointer leaves that item by default. Set `keepHighlight: true` to preserve it.
Touch pointer movement never creates a hover highlight.

Filtered lists preserve the highlighted item's declared value identity rather than a transient
filtered index. `aria-activedescendant` always uses the item's canonical declared ID and disappears
when filtering removes or disables that item. Values are equally strict: initial, controlled,
Field-backed, and programmatic selection values must use declared items, match single/multiple
shape, and contain no duplicates. `select()`/`choose()` throw for unknown values instead of
silently creating state an agent cannot later identify.

### Drawer snap points and gestures

Drawer snap points describe visible size. Numbers from `0` through `1` are viewport fractions,
numbers above `1` are CSS pixels, and strings accept only non-negative `px` or `rem` lengths:

```ts
const drawer = createDrawer({
  id: "project-details",
  direction: "bottom",
  snapPoints: [0.35, "32rem"],
  defaultSnapPoint: 0.35,
  snapToSequentialPoints: true,
  onSnapPointChange(next, details) {
    if (!mayResize.value) details.cancel();
  },
});
```

`snapPoint: null` means fully expanded without a configured snap. Mounted `viewport()` and
`popup()` parts measure automatically; `measure()` supplies deterministic dimensions to tests or
non-DOM renderers. Resolved sizes clamp to the smaller of viewport and popup, and equivalent
resolved points are deduplicated.

Pointer release chooses a point from drag distance and velocity. `snapToSequentialPoints` prevents
a fast gesture from skipping intermediate points. `swipeArea()` can open from an edge;
`content({ swipeIgnore: true })` excludes an interactive subtree; pointer cancel or lost capture
rolls back without committing. `dismissible: false` retains the drawer at its nearest point.
Application CSS consumes `--drawer-snap-point-offset`, `--drawer-swipe-progress`,
`--drawer-swipe-strength`, and the axis movement variables. The controller provides measurements
and state, not the transform or transition theme.

### Toast swipe ownership

Toast swipe dismissal starts only from a non-interactive descendant of `root(id)`. Links, buttons,
inputs, selects, textareas, summaries, contenteditable regions, and descendants marked with
`data-base-ui-swipe-ignore` or `data-swipe-ignore` retain their normal interaction. Pointer cancel,
lost pointer capture, root unmount, and provider disposal all release capture, clear swipe offsets,
and resume the manager's swipe pause, so a removed toast cannot leave every timer paused.

Toast roots reference `title()` and `description()` only while those parts are actually rendered,
so optional anatomy never produces dangling ARIA IDs. F6 does nothing when there are no visible
toasts. If a keyboard-focused toast is dismissed, focus moves to another visible toast or returns
to the element that was focused before F6 navigation.

## Native forms and validation

Headless visual controls still need real form participation:

- Checkbox, Checkbox Group, Radio, and Switch expose `input()` parts synchronized with the visual
  root. Render them to receive native names, values, required validation, and reset events.
- Native checkboxes submit nothing while unchecked. Checkbox and Switch preserve that default.
  When an API needs an explicit off value, configure `uncheckedValue` and render
  `uncheckedInput()` too. That hidden projection is enabled only while the control is unchecked and
  has a name; the checked native input and unchecked projection are never successful together.
- Checkbox Group additionally exposes `parentState`, `toggleAll()`, `parent(options)`, and
  `parentIndicator(options)` for a “select all” checkbox. The parent reports checked, unchecked, or
  mixed state, names every child in `aria-controls`, and toggles only mutable choices while
  retaining selected disabled/read-only choices. A reactive `indeterminate` part option can add an
  application-owned mixed state for nested groups.
- Checkbox, Checkbox Group, and Radio `indicator()` parts accept `{ keepMounted: true }` when CSS
  transitions need a persistent node. An inactive kept-mounted indicator remains present with
  `data-state="unchecked"` and `data-unchecked`; without the option, inactive indicators receive
  `hidden`.
- Input accepts only the safe native text-like types `text`, `search`, `email`, `tel`, `url`, and
  `password`. Number Field uses its `input()` as the editable form control.
- OTP Field exposes `hiddenInput()` for one logical submitted value; the visible `input(index)`
  slots each receive an accessible label, not a form name. Its Field and agent manifests redact the
  code. `onValueComplete` runs when an incomplete value becomes complete and on a complete paste,
  even if that paste repeats the current code. `onComplete` is a deprecated alias. With
  `autoSubmit: true`, an uncanceled completion requests submission from the owning form in a
  microtask; canceling the completion details prevents submission without discarding the value.
- Slider exposes one hidden native range `input(index)` for each thumb. Render all of them if every
  thumb value must be submitted. Name range thumbs distinctly with
  `thumb(index, { ariaLabel, ariaLabelledBy, getAriaLabel })`; customize announced values with
  `ariaValueText` or `getAriaValueText(formatted, value, index)`. Explicit relationships take
  precedence over the shared Slider Label, and a Label that was never requested or was unmounted is
  never referenced.
- Select and Combobox expose `hiddenInputs()` for serialized committed values. Call the getter once
  while constructing markup and render the returned array. Multiple mode mounts one stable hidden
  input per declared item and reactively disables unselected entries, so live changes do not depend
  on rerendering the component. Non-primitive values require a `serialize` function.
- Single-value Autocomplete submits its free-form `input()` directly when `name` is supplied.
  Multiple Autocomplete can use `hiddenInputs()` for committed declared items; uncommitted free
  text remains input state rather than a submitted selected value.
- Required Select and multi-value editable selections include a visually hidden native validation
  proxy. Render the complete returned projection so invalid form submission can focus the visible
  trigger or input.
- `form="form-id"` works for supported native projections outside the form subtree.

`createField()` adds labeling, descriptions, native validity, application validation, async
cancellation, server errors, and interaction state to a control. `label()`, `description()`, and
`error()` reserve their IDs when requested so SSR can emit complete relationships, and their `use`
directives release those IDs when the parts unmount. Controls therefore reactively gain and lose
`aria-labelledby`, `aria-describedby`, and `aria-errormessage`; a part that was never requested is
never referenced. The same mount-aware rule applies to standalone Select, Combobox, Autocomplete,
Slider, Meter, and Progress labels. Use a Field `label()` on a real `<label>` and `control()` on an
input, textarea, or select unless you deliberately supply equivalent semantics. When rendering
more than one matched `error()` part, give each one an explicit unique `id`; the default error ID is
intended for a single aggregate error element.

### Typed Field composition

UI factories can consume a `FieldController` directly. They inherit its `name`, `disabled`,
`readOnly`, and `required` state, project dirty/touched/filled/focused/pending/valid/invalid data
hooks, reuse its live accessible relationships, and synchronize values in both directions.

| Family and mode | Field logical value |
| --- | --- |
| Select and Combobox, single | `Value | null` |
| Select and Combobox, multiple | `readonly Value[]` |
| Autocomplete, single | free-form `string` input |
| Autocomplete, multiple | selected `readonly Value[]` |

The public aliases are `SelectionValue<Value> = Value | readonly Value[] | null` and
`AutocompleteFieldValue<Value> = string | readonly Value[]`. Select, Combobox, and multiple
Autocomplete cannot combine `field` with explicit `value`; single Autocomplete cannot combine
`field` with explicit `inputValue`. Clank rejects those ambiguous ownership configurations when the
controller is created.

Field synchronization keeps structured cancellation intact. A rejected selection does not close
the popup or advance related text, a rejected free-form input restores the mounted native input,
and paired committed-value/text changes roll back together. Field-backed selection values are
validated against the declared item set just like defaults and controlled values. Their hidden
native validation proxy mirrors the controls that can actually submit, forwards native validity to
the Field, and focuses the visible trigger/input on invalid submission. A required selection with
no name/native projection cannot report a misleading valid native state.

`validationMode` is `"onSubmit"` by default and can be `"onBlur"` or `"onChange"`. Native
`ValidityState`, the native validation message, synchronous or abortable asynchronous application
validation, and server errors feed one field state. A new value aborts stale validation and clears
server errors. Native form reset and programmatic reset use the same state transition; a canceled
native reset is ignored, repeated listeners deduplicate the same reset event, and accepted resets
clear dirty/touched/pending/error state.

`createFormFacade()` coordinates registered fields, awaits validation before submission, prevents
duplicate stale submission state, optionally focuses the first invalid control, and supplies both
cloned controller values and mounted `FormData`. It is intentionally named differently from the
schema-oriented `createForm()` API exported by Clank's forms module.

```tsx
function ProfileForm() {
  const email = createField({
    id: useId("email"),
    name: "email",
    defaultValue: "",
    required: true,
    validationMode: "onBlur",
    async validate(value, { signal }) {
      if (!value.includes("@")) return "Enter a valid email address.";
      const response = await fetch(`/api/email-available?q=${encodeURIComponent(value)}`, { signal });
      return response.ok ? undefined : "That address is already registered.";
    },
  });
  const form = createFormFacade({
    id: useId("profile-form"),
    async onFormSubmit(values) {
      await saveProfile(values);
    },
  });
  const unregister = form.register("email", email);

  onMount(() => () => {
    unregister();
    email.dispose();
    form.dispose();
  });

  return (
    <form {...form.root()} class="space-y-4">
      <div {...email.root()} class="space-y-1">
        <label {...email.label()} class="font-medium">Email</label>
        <input
          {...email.control({ type: "email" })}
          class="w-full rounded-lg border px-3 py-2 data-[invalid]:border-red-600"
        />
        <p {...email.description()}>Used for account recovery.</p>
        <p {...email.error()} class="text-sm text-red-700">
          {() => email.errors.value.join(" ")}
        </p>
      </div>
      <button type="submit" disabled={() => form.pending.value}>
        Save profile
      </button>
    </form>
  );
}
```

Async validation receives an `AbortSignal`. Changing the value or starting a newer validation aborts stale work so an older response cannot overwrite the current result. Server errors set through `field.setServerErrors()` or `form.setErrors()` clear when that field changes.

## Agent-readable manifests

Every catalog controller exposes `manifest()`. It returns a detached, JSON-safe snapshot using protocol `clank-ui/1`:

```ts
const snapshot = select.manifest();

console.log(snapshot.component); // "Select"
console.log(snapshot.parts);     // semantic anatomy
console.log(snapshot.actions);   // available controller actions
console.log(snapshot.keyboard);  // keyboard contract when applicable
```

A manifest contains:

- `component` and stable `id`;
- serializable current `state`;
- part names, roles, default elements, and required markers;
- controller actions, optional reasons, and a side-effect classification;
- a keyboard map when the family defines one.

Call `manifest()` again after state changes; the returned object is a snapshot, not a live signal. Manifests created through `createUiManifest()` are validated and frozen. Control manifests additionally include `kind`, part descriptions, and action parameter descriptions.

Interactive part getters that accept `agentId`, `agentLabel`, or `agentDescription` pass that semantic metadata to Clank's DOM agent inspector. Use stable IDs and specific labels such as “Archive project,” not visual descriptions such as “gray button.” Agent metadata does not grant authority: server actions, MCP tools, and mutations must still enforce authentication and authorization.

Sensitive values receive extra treatment. Password Input manifests report `[redacted]`, and OTP Field manifests expose only masked length. Application code must apply the same discipline to custom manifests, labels, descriptions, logs, and toast metadata.

For code generation and inspection, the `/ui/catalog` entry point exposes:

- `UI_COMPONENT_COUNT`, fixed at `37`;
- `BASE_UI_REFERENCE_VERSION` (`"1.6.0"`) and the pinned upstream release URL;
- immutable `UI_COMPONENT_CATALOG` records with name, slug, factory, module, canonical parts,
  form association, description, `referenceVersion`, and per-family `referenceUrl`;
- `UI_COMPONENT_FACTORIES`, a runtime lookup from canonical family name to factory;
- `getUiCatalogEntry(nameOrSlug)` for canonical-name or kebab-case lookup. Literal names and slugs
  resolve to the exact `UiCatalogEntryFor<Key>` type; arbitrary strings return an entry or
  `undefined`.

Use this inventory instead of maintaining a second hard-coded family list in an agent.

## Complete 37-family catalog

Part names below are the immutable canonical `UI_COMPONENT_CATALOG.parts` values, not necessarily
JavaScript method spellings. Hyphenated `scrub-area` maps to `scrubArea()`, for example; `value`
maps to `valuePart()` for Select/Combobox and `valueText()` for Slider. Shared controller methods
can expose useful parts that are intentionally outside one family's canonical anatomy. Render
repeated parts once per declared item, option, thumb, or toast as appropriate.

| Family | Factory | Canonical catalog anatomy | Implemented behavior |
| --- | --- | --- | --- |
| **Accordion** | `createAccordion()` | `root`, `item`, `header`, `trigger`, `panel` | Single or multiple disclosure, nullable single state, ordered/cancelable state, explicit panel mounting, keep-mounted or until-found panels, native Tab order, and Enter/Space activation. Arrow keys remain available to the page. |
| **Alert Dialog** | `createAlertDialog()` | `trigger`, `portal`, `backdrop`, `viewport`, `popup`, `title`, `description`, `close` | Modal `alertdialog`, focus trap/restoration, inert background, scroll lock, and top-layer Escape. Outside and backdrop presses never dismiss it. |
| **Autocomplete** | `createAutocomplete()` | `label`, `input-group`, `input`, `trigger`, `icon`, `clear`, `value`, `portal`, `backdrop`, `positioner`, `popup`, `arrow`, `status`, `empty`, `list`, `row`, `item`, `separator`, `group`, `group-label`, `collection` | Free-form native input with canonical active-descendant suggestions, custom or locale-aware filtering, four completion modes, typed Field composition, explicit popup presence, opt-in input-click opening, and configurable pointer-leave highlighting. Single mode submits the input directly. |
| **Avatar** | `createAvatar()` | `root`, `image`, `fallback` | Controlled or uncontrolled `idle`, `loading`, `loaded`, and `error` status; image load/error wiring; an accessible fallback that remains exposed when visible; SSR-safe initial state. |
| **Button** | `createButton()` | `root` | Native-first cancelable press handling, disabled or focusable-disabled behavior, form attributes, and correct Enter-keydown/Space-keyup activation for a custom element. |
| **Checkbox** | `createCheckbox()` | `root`, `indicator`, `input`, `unchecked-input` | Checked, unchecked, and indeterminate state; Space activation; native checkbox synchronization, optional explicit unchecked projection, submission, required state, and form reset. |
| **Checkbox Group** | `createCheckboxGroup()` | `root`, `parent`, `parent-indicator`, `item`, `indicator`, `input` | Ordered multiple values, checked/mixed “select all” parent APIs, per-item disabled/read-only state, one-or-more native required validation, repeated form values, and reset coordination. |
| **Collapsible** | `createCollapsible()` | `trigger`, `panel` | Controlled or uncontrolled disclosure, disabled state, cancelable reasons, transition-aware presence, keep-mounted mode, optional `hidden="until-found"`, and native trigger activation. |
| **Combobox** | `createCombobox()` | `label`, `input-group`, `input`, `trigger`, `icon`, `clear`, `value`, `chips`, `chip`, `chip-remove`, `portal`, `backdrop`, `positioner`, `popup`, `arrow`, `status`, `empty`, `list`, `row`, `item`, `item-indicator`, `separator`, `group`, `group-label`, `collection`, `form-control`, `hidden-input` | Editable single or multiple selection strictly restricted to declared items, typed Field composition, atomic committed-value/text changes, input-click opening by default, canonical active descendants, explicit popup presence, chips, and mount-stable native form projection. |
| **Context Menu** | `createContextMenu()` | `trigger`, `portal`, `backdrop`, `positioner`, `popup`, `arrow`, `item`, `link-item`, `submenu-root`, `submenu-trigger`, `group`, `group-label`, `radio-group`, `radio-item`, `radio-item-indicator`, `checkbox-item`, `checkbox-item-indicator`, `separator` | Pointer-coordinate virtual anchoring, right-click, touch long-press with movement tolerance, focus restoration to the invocation target, and the complete Menu item model. The controller's source-target method is named `target()`. |
| **Dialog** | `createDialog()` | `trigger`, `portal`, `backdrop`, `viewport`, `popup`, `title`, `description`, `close` | Modal by default, explicit portal presence through open/ending/kept-mounted states, nested top-layer handling, initial/final focus, Tab wrapping, configurable dismissal, inerting, scroll lock, and focus restoration. |
| **Drawer** | `createDrawer()` | `provider`, `indent-background`, `indent`, `trigger`, `swipe-area`, `portal`, `backdrop`, `viewport`, `popup`, `content`, `title`, `description`, `close`, `virtual-keyboard-provider` | Dialog semantics plus edge opening/dismissal, axis-locked pointer gestures, nested indentation, virtual-keyboard inset, measured snap points, velocity-aware release, and sequential snapping. |
| **Field** | `createField()` | `root`, `label`, `control`, `description`, `item`, `error`, `validity` | Mount-aware label/description/error wiring, native validity, sync or abortable async validation, debounce, matched and server errors, typed control composition, dirty/touched/filled/focus/pending state, and reset. |
| **Fieldset** | `createFieldset()` | `root`, `legend` | Native `fieldset` and `legend` semantics, reactive disabled propagation, form association, and manifest metadata. |
| **Form** | `createFormFacade()` | `root` | Field registration, values and `FormData`, server-error distribution, whole-form or named validation, first-invalid focus, async submission, pending/submitted state, and reset. |
| **Input** | `createInput()` | `root` | Controlled or uncontrolled safe text-like native input, optional Field composition, reactive constraints/state, password manifest redaction, and coordinated form reset. |
| **Menu** | `createMenu()` | `trigger`, `portal`, `backdrop`, `positioner`, `popup`, `viewport`, `arrow`, `item`, `link-item`, `submenu-root`, `submenu-trigger`, `group`, `group-label`, `radio-group`, `radio-item`, `radio-item-indicator`, `checkbox-item`, `checkbox-item-indicator`, `separator` | Roving focus, typeahead, actions, validated links, controlled checkbox/radio values, delayed nested submenus, per-item close policy, RTL-aware nested keys, Escape focus restoration, and Tab dismissal with native focus continuity. |
| **Menubar** | `createMenubar()` | `root`, `item`, `trigger`, `link`, `menu`, `separator` | One open top-level menu, direction-aware horizontal roving, typeahead, menu switching on pointer or keyboard movement, links, and focus return. |
| **Meter** | `createMeter()` | `root`, `label`, `track`, `indicator`, `value` | Clamped min/max measurement, `meter` ARIA values and optional value text, percentage state, and a percentage CSS variable. |
| **Navigation Menu** | `createNavigationMenu()` | `root`, `list`, `item`, `trigger`, `icon`, `content`, `link`, `portal`, `backdrop`, `positioner`, `popup`, `arrow`, `viewport`, `indicator` | Trigger flyouts and current links, explicit popup naming, delayed hover intent without focus theft, external-focus dismissal, opt-in link closing, roving/typeahead with disabled recovery, orientation/RTL, collision-aware position, measured viewport/indicator, active-content focus, and Escape restoration. |
| **Number Field** | `createNumberField()` | `root`, `scrub-area`, `scrub-area-cursor`, `group`, `decrement`, `input`, `increment` | Locale-aware nullable input whose first step seeds zero before bounds are applied, min/max and snapping, regular/small/large steps, keyboard and opt-in focused-wheel input, repeating held step buttons, pointer scrubbing, and commit callbacks. |
| **OTP Field** | `createOtpField()` | `root`, `input`, `separator`, `hidden-input` | Numeric/alpha/alphanumeric/regex/custom normalization, paste distribution, masking, RTL navigation, deletion, logical first-slot labeling, exact completion notifications, cancelable optional form submit, one native form value, and manifest redaction. |
| **Popover** | `createPopover()` | `trigger`, `portal`, `backdrop`, `positioner`, `popup`, `arrow`, `viewport`, `title`, `description`, `close` | Non-modal anchored popup by default, explicit conditional/kept-mounted portal presence, configurable dismissal/focus, collision-aware placement and arrow, optional hover opening, and focus restoration. |
| **Preview Card** | `createPreviewCard()` | `trigger`, `portal`, `backdrop`, `positioner`, `popup`, `arrow`, `viewport` | Non-modal sighted-user preview with delayed pointer/focus opening and delayed closing that permits pointer travel into the popup. It does not replace accessible trigger content. |
| **Progress** | `createProgress()` | `root`, `label`, `track`, `indicator`, `value` | Determinate or `null` indeterminate progress, clamped values, progressbar ARIA, status hooks, optional value text, and a percentage CSS variable. |
| **Radio** | `createRadioGroup()` | `root`, `item`, `indicator`, `input` | Single selection, roving focus with internal Field-focus containment, orientation-aware arrows, Home/End, disabled/read-only items, native radio submission and required validation, and reset. |
| **Scroll Area** | `createScrollArea()` | `root`, `viewport`, `content`, `scrollbar`, `thumb`, `corner` | Native scrolling with independently named accessible tracks, two-axis measurement, resize updates, keyboard/wheel/track/thumb input, Ctrl+wheel zoom preservation, boundary scroll chaining, touch preservation, normalized RTL browser models, and a deduplicated WebKit scrollbar-hiding rule. |
| **Select** | `createSelect()` | `label`, `trigger`, `value`, `icon`, `portal`, `backdrop`, `positioner`, `popup`, `scroll-up-arrow`, `arrow`, `list`, `item`, `item-text`, `item-indicator`, `separator`, `group`, `group-label`, `scroll-down-arrow`, `form-control`, `hidden-input` | Strict single or multiple listbox selection, closed single-select typeahead, typed Field composition with popup-focus containment, mount-aware labels, explicit popup presence, disabled options, looping arrows, Home/End, grouping, modal behavior by default, and mount-stable serialized form values. |
| **Separator** | `createSeparator()` | `root` | Horizontal or vertical semantic separator, or a decorative presentation-only separator, with orientation hooks. |
| **Slider** | `createSlider()` | `root`, `label`, `value`, `control`, `track`, `indicator`, `thumb`, `input` | Single or multi-thumb values, per-thumb accessible name/value-text APIs, mount-aware shared labels, atomic cancelable pointer gestures and thumb swaps, full keyboard input, RTL/vertical geometry, native range projection, min gaps, collision policies, and commit callbacks. |
| **Switch** | `createSwitch()` | `root`, `thumb`, `input`, `unchecked-input` | Binary `switch` semantics, controlled state, disabled/read-only/required state, visual/native synchronization, optional explicit off-value projection, keyboard activation, submission, and reset. |
| **Tabs** | `createTabs()` | `root`, `list`, `tab`, `panel`, `indicator` | Nullable selection, manual activation by default or automatic activation, roving focus, orientation/RTL arrows, Home/End, focusable disabled tabs, panel relationships, and measured indicator variables. |
| **Toast** | `createToastProvider()` | `provider`, `portal`, `viewport`, `positioner`, `root`, `content`, `title`, `description`, `action`, `close`, `arrow` | Provider over a standalone manager: stable IDs, deduplication, visible limit/FIFO queue, exact pause/resume timers, promise tracking, mounted-part ARIA, empty-safe F6 and dismissal focus recovery, anchors, stacking variables, interaction-safe swipe dismissal, and leak-free swipe cleanup. |
| **Toggle** | `createToggle()` | `root` | Controlled or uncontrolled pressed state, `aria-pressed`, disabled state, Enter/Space activation, reset, and agent metadata. |
| **Toggle Group** | `createToggleGroup()` | `root`, `item` | Single nullable or ordered multiple values, persistent roving arrow/Home/End focus, dynamic disabled recovery, read-only state, orientation, looping, controlled state, and reset. |
| **Toolbar** | `createToolbar()` | `root`, `button`, `link`, `input`, `group`, `separator` | One-Tab-stop direction-aware roving with disabled recovery, reactive whole-toolbar disabling, Base UI-compatible `loopFocus` (`loop` alias), cancelable buttons, validated links, editable inputs that retain editing keys, labeled groups, and semantic/decorative separators. |
| **Tooltip** | `createTooltip()` | `provider`, `trigger`, `portal`, `positioner`, `popup`, `arrow`, `viewport` | Shared delay provider with transactional single-tooltip ownership, non-modal `tooltip`, delayed pointer/focus open/close, optional hoverable popup and click closing, collision-aware placement, and Escape/focus dismissal. Canceled opens never take ownership; if the active tooltip vetoes closing, the contender rolls back. The trigger still needs its own accessible name. |

## Shared foundations

The public UI entry point also exposes the lower-level building blocks used by the catalog:

| API | Purpose |
| --- | --- |
| `createControllableState()` and `createChangeDetails()` | The controlled/uncontrolled and structured-cancellation contract. |
| `mergeProps()` and `mergeRefs()` | Safe composition of handlers, classes, styles, ARIA token lists, directives, and refs. |
| `createIdScope()`, `createUiIdScope()`, and `createUiId()` | Explicit deterministic IDs for non-component code; rendered components normally use `useId()`. |
| `UiProvider`, `DirectionProvider`, and `CSPProvider` | Request-owned direction and CSP metadata without a wrapper element. |
| `renderPart()` | Default-element, VNode, or render-function composition for design-system wrappers. |
| `createInteractionState()` | Shared hover, pressed, focus, and focus-visible state for custom parts. |
| `createMediaQuery()` | Reactive media matching with an SSR-stable default. |
| `createOverlay()` | Document-scoped top-layer dismissal, modal inerting, focus trapping/restoration, branches, and scroll lock. |
| `createFloating()` | Dependency-free anchored flip, shift, alignment, arrow coordinates, and auto-update. |
| `createPresence()` | Entry/exit data states and transition-aware retained mounting. |
| `resolveDirection()` and `resolveLogicalSide()` | Inherited RTL resolution and logical-to-physical sides. |
| `isFocusable()`, `focusableElements()`, and `focusFirst()` | Shadow-aware native focus discovery and safe focus attempts. |
| `getCollectionNavigationIntent()` and `findCollectionIndex()` | Orientation-, direction-, loop-, page-, and disabled-aware collection movement. |
| `createTypeahead()` and `findTypeaheadMatch()` | Isolated prefix buffers, repeated-key cycling, locale matching, and disabled-item skipping. |
| `dataState()` | A common `data-state` plus Base UI-style boolean data flags. |
| `createUiManifest()` | Validation, cloning, freezing, and serialization of `clank-ui/1` manifests. |

Use these foundations when a product needs a new interaction pattern that is not one of the 37 families. Reusing them keeps cancellation, ownership, RTL, focus, and agent semantics consistent with the built-in catalog.

## Lifecycle and cleanup

Controllers that install timers, effects, measurement observers, or document listeners expose `dispose()`. Register it with the owning component:

```tsx
const menu = createMenu({ id: useId("actions"), items });
onMount(() => menu.dispose);
```

Some part-level `use` directives return their own cleanup; Clank's renderer owns those automatically when the part is unmounted. Do not call a directive manually unless you also retain and invoke its cleanup.

Controller disposal is idempotent. It removes document listeners, observers, timers, form-reset
bindings, pending validation, overlay locks, and provider-owned children as applicable; it does not
remove application DOM. Simple controllers whose state is entirely owned by Clank signals and
native part directives do not expose or need a controller-level disposer.

Create `createMediaQuery()` inside a mounted component so its listener belongs to that component's
`onMount` cleanup. If it is deliberately created outside a component in a browser, the returned
signal has no standalone disposer and the media-query listener remains for the page lifetime.

Call each part getter once while constructing its element. Repeated calls return fresh prop objects
and, for helpers such as `hiddenInputs()`, a fresh projection description; they are not render
operations and should not be polled as state. Read controller signals or call `manifest()` when a
fresh state snapshot is needed.

## Boundaries and deliberate limitations

- This is behavior and anatomy alignment with Base UI 1.6, not React component or TypeScript API
  compatibility. Base UI examples must be translated to Clank controller/part markup.
- Item collections are normalized when a controller is created. Values and order are static for
  that controller; reactive `value`, `open`, and supported `disabled` getters can change in place.
  Recreate the controller when items are inserted, removed, renamed, or reordered.
- The library renders no visual shell, focus ring, icon, text, or responsive layout. Required ARIA
  roles and relationships assume you spread the complete props onto the recommended native parts.
- Default utility labels such as “Clear,” “Open suggestions,” and OTP slot labels are English.
  `Intl.Collator` and `Intl.NumberFormat` handle filtering and numbers, but there is no global
  translation dictionary. Override application-facing text/ARIA props after the headless props
  with `mergeProps()` where a factory does not expose an explicit label option.
- Portals, overlays, focus restoration, and floating anchors are scoped to one owner document.
  Iframes and popup windows need separate controller trees; cross-document portal targets fail.
- The collision engine provides one-anchor flip, shift, clipping-ancestor bounds, arrow position,
  and auto-update. It does not implement arbitrary middleware or every placement strategy from
  Floating UI.
- Strict `style-src-attr 'none'` policies require a policy-specific adapter for measured inline
  positions and CSS variables. `CSPProvider` carries nonce metadata; it cannot relax CSP.
- Native form projections provide browser submission/reset/required behavior, but domain rules,
  server validation, authentication, and authorization remain application responsibilities.
- Correct SSR hydration requires identical initial controller trees, IDs, item order, locale,
  direction, and state. A mismatch uses Clank's remount fallback rather than guessing intent.

## Compatibility helpers

The UI entry point retains four older helpers outside the 37-family catalog:

- `createDisclosure()` preserves the original `initialOpen`/`onChange` API. New code should use `createCollapsible()`.
- `createPagination()` provides clamped pagination state and a compact page/ellipsis range.
- `clickOutside()` is a captured pointer directive for a simple non-layered region. Popup families should use their shared overlay behavior instead.
- `autoFocus` focuses a connected element in the next microtask.

## Verification

For a focused repository check after changing the library:

```sh
npm run build
node --test tests/ui-*.test.mjs tests/dom.test.mjs tests/ssr.test.mjs
npm run docs:audit
```

Before merging or publishing, run the complete release gate:

```sh
npm run check
npm pack --dry-run --json --ignore-scripts
```

The catalog tests compare all 37 immutable catalog records with live controller manifests, import
every family subpath, and reject non-local UI imports or package dependency fields. Focused suites
cover state, cancellation, keyboard dispatch, focus/overlay behavior, gestures, forms/reset,
floating/presence, portals, SSR, and hydration. `npm run check` additionally builds the docs,
runs the repository coverage gate, documentation audit, packaged-release conformance, and security
audit.

These gates verify the library contract; they cannot certify an application's chosen markup,
copy, colors, responsive CSS, or authorization. Run the rendered application in real desktop and
mobile browsers with keyboard, touch, assistive technology, LTR/RTL, strict CSP, and its actual
server actions before shipping it.

## Application checklist

Before shipping a component built from the headless catalog:

1. Render every required part and every required native form projection.
2. Preserve the controller's handlers, refs, directives, IDs, and ARIA props with full spreads or `mergeProps()`.
3. Give controls, navigation regions, groups, dialogs, and tooltips meaningful human-accessible names.
4. Verify controlled callbacks update external state and deliberately handle cancellation reasons.
5. Call `dispose()` for controllers that expose it.
6. Test Tab order, documented keys, Escape, focus return, pointer, touch, LTR, RTL, and disabled/read-only states.
7. Render and hydrate the same initial tree; investigate any `data-clank-hydration="remounted"` result.
8. Compile Tailwind classes in production and preserve visible focus and reduced-motion behavior.
9. Inspect `manifest()` output after meaningful states, including sensitive and error states.
10. Keep authorization in server actions and MCP tools; headless UI and agent metadata never replace it.
