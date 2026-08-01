/* @clankImportSource ../vendor/dom.js */
import { For, Portal, Show, onCleanup, signal } from "../vendor/dom.js";
import {
  createAccordion,
  createAlertDialog,
  createAutocomplete,
  createAvatar,
  createBottomSheet,
  createButton,
  createCheckbox,
  createCheckboxGroup,
  createCollapsible,
  createCombobox,
  createContextMenu,
  createDialog,
  createDrawer,
  createField,
  createFieldset,
  createFormFacade,
  createInput,
  createMenu,
  createMenubar,
  createMeter,
  createNavigationMenu,
  createNumberField,
  createOtpField,
  createPagination,
  createPopover,
  createPreviewCard,
  createProgress,
  createRadioGroup,
  createScrollArea,
  createSelect,
  createSeparator,
  createSlider,
  createSwitch,
  createTabs,
  createToastProvider,
  createToggle,
  createToggleGroup,
  createToolbar,
  createTooltipProvider,
} from "../vendor/ui.js";

const optionItems = [
  { value: "design", label: "Design systems" },
  { value: "agents", label: "Agent interfaces" },
  { value: "platform", label: "Deployment platforms" },
  { value: "auth", label: "Authentication", keywords: ["login", "security"] },
  { value: "data", label: "Databases", keywords: ["sqlite", "storage"] },
  { value: "realtime", label: "Realtime collaboration", keywords: ["live", "sync"] },
  { value: "jobs", label: "Background jobs", keywords: ["queue", "cron"] },
  { value: "analytics", label: "Product analytics", keywords: ["metrics", "funnels"] },
  { value: "billing", label: "Usage billing", keywords: ["plans", "payments"] },
  { value: "domains", label: "Custom domains", keywords: ["dns", "tls"] },
  { value: "mcp", label: "Agent protocol", keywords: ["mcp", "tools"] },
  { value: "observability", label: "Observability", keywords: ["logs", "traces"] },
] as const;
const collectionItems = [
  { value: "overview", textValue: "Overview" },
  { value: "details", textValue: "Details" },
  { value: "activity", textValue: "Activity" },
] as const;

function cleanup(...controllers: Array<{ dispose?: () => void } | undefined>) {
  if (typeof document === "undefined") return;
  onCleanup(() => controllers.forEach((controller) => controller?.dispose?.()));
}

function HiddenInput(props: Record<string, unknown>) {
  return <input {...props} class="native-projection" />;
}

function CheckGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.2 8.2 3 3.1 6.7-7" /></svg>;
}

function Chevron() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>;
}

function PopupLayer(props: { popup: any; kind?: string; children: unknown }) {
  const popup = props.popup;
  return (
    <Show when={() => popup.isMounted()}>
      <Portal>
        <div {...popup.portal()} class="portal-root">
          <div {...popup.positioner()} class="floating-positioner">
            <div {...popup.popup()} class={`demo-floating ${props.kind ?? ""}`}>{props.children}</div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function MenuLayer(props: { menu: any; children?: unknown }) {
  const menu = props.menu;
  const hasChildren = Array.isArray(props.children) ? props.children.length > 0 : props.children !== null && props.children !== undefined;
  return (
    <Show when={() => menu.isMounted()}>
      <Portal>
        <div {...menu.portal()} class="portal-root">
          <div {...menu.positioner()} class="floating-positioner">
            <div {...menu.popup()} class="demo-menu">
              {hasChildren ? props.children : (
                <>
                  <button {...menu.item("new")} class="demo-menu-item"><span>New document</span><kbd>⌘N</kbd></button>
                  <button {...menu.item("duplicate")} class="demo-menu-item"><span>Duplicate</span><kbd>⌘D</kbd></button>
                  <div {...menu.separator()} class="demo-separator" />
                  <button {...menu.checkboxItem("comments")} class="demo-menu-item">
                    <span {...menu.checkboxItemIndicator("comments", { keepMounted: true })} class="menu-check"><CheckGlyph /></span>
                    <span>Show comments</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

export function AccordionStory() {
  const accordion = createAccordion({
    id: "story-accordion",
    items: collectionItems,
    defaultValue: "overview",
    collapsible: true,
  });
  return (
    <div {...accordion.root()} class="demo-accordion">
      <For each={collectionItems} by="value">
        {(item) => (
          <section {...accordion.item(item.value)} class="accordion-item">
            <h3 {...accordion.header(item.value)}>
              <button {...accordion.trigger(item.value)} class="accordion-trigger"><span>{item.textValue}</span><Chevron /></button>
            </h3>
            <Show when={() => accordion.isPanelMounted(item.value)}>
              <div {...accordion.panel(item.value)} class="accordion-panel">
                {item.value === "overview" ? "A dependency-free primitive with complete keyboard behavior." : item.value === "details" ? "Every semantic part exposes stable data attributes and agent metadata." : "State changes include their exact reason and can be canceled."}
              </div>
            </Show>
          </section>
        )}
      </For>
    </div>
  );
}

export function AlertDialogStory() {
  const dialog = createAlertDialog({ id: "story-alert", modal: "modal" });
  cleanup(dialog);
  return (
    <>
      <button {...dialog.trigger()} class="demo-button danger">Delete release</button>
      <Show when={() => dialog.isMounted()}>
        <Portal>
          <div {...dialog.portal()} class="portal-root">
            <div {...dialog.backdrop()} class="demo-backdrop" />
            <div {...dialog.viewport()} class="dialog-viewport">
              <div {...dialog.dialog()} class="demo-dialog compact">
                <span class="dialog-icon danger">!</span>
                <h3 {...dialog.title()}>Delete this release?</h3>
                <p {...dialog.description()}>This action removes the artifact permanently. The active release is never eligible.</p>
                <div class="dialog-actions"><button {...dialog.close()} class="demo-button quiet">Cancel</button><button {...dialog.close()} class="demo-button danger">Delete release</button></div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}

function EditableSelectionStory(props: { mode: "autocomplete" | "combobox" }) {
  const selection = props.mode === "autocomplete"
    ? createAutocomplete({ id: "story-autocomplete", items: optionItems, completionMode: "both", autoHighlight: true, openOnInputClick: true, presentation: "responsive" })
    : createCombobox({ id: "story-combobox", items: optionItems, defaultValue: "design", autoHighlight: true, presentation: "responsive" });
  cleanup(selection);
  const searchLabel = props.mode === "autocomplete" ? "Search topics" : "Search workspaces";
  return (
    <div class="demo-field-stack wide-control">
      <label {...selection.label()} class="demo-label">{props.mode === "autocomplete" ? "Explore capabilities" : "Primary workspace"}</label>
      <Show
        when={() => props.mode === "combobox"}
        fallback={<div {...selection.inputGroup()} class="combo-group"><input {...selection.input()} class="demo-input" placeholder="Start typing…" /><button {...selection.clear()} class="icon-button" aria-label="Clear">×</button><button {...selection.trigger()} class="icon-button" aria-label="Open options"><Chevron /></button></div>}
      >
        <button {...selection.trigger({ standalone: true })} class="select-trigger combo-select-trigger"><span {...selection.valuePart({ placeholder: "Choose a workspace" })} /><span {...selection.icon()}><Chevron /></span></button>
      </Show>
      <For each={selection.hiddenInputs()}>{(input) => <HiddenInput {...input} />}</For>
      <Show when={() => selection.isMounted()}>
        <Portal>
          <div {...selection.portal()} class="portal-root selection-portal">
            <div {...selection.backdrop()} class="selection-backdrop" />
            <div {...selection.positioner()} class="floating-positioner selection-positioner">
              <div {...selection.popup()} class="demo-floating selection-popup adaptive-selection-popup">
                <div class="selection-sheet-handle" aria-hidden="true"><span /></div>
                <div class="selection-sheet-header"><div><small>{props.mode === "autocomplete" ? "Free-form search" : "Choose one"}</small><strong>{searchLabel}</strong></div><button type="button" class="selection-sheet-close" aria-label="Close options" onClick={(event: Event) => selection.hide("close-press", event)}>×</button></div>
                <div class="selection-popup-search"><span aria-hidden="true">⌕</span><input {...selection.input({ insidePopup: true, ariaLabel: searchLabel })} placeholder="Type to filter…" /></div>
                <span {...selection.status()} class="demo-status selection-result-status" />
                <div {...selection.list()} class="selection-list">
                  <For each={selection.filteredItems} by="value" fallback={<div {...selection.empty()} class="empty-option">No matching capabilities</div>}>
                    {(item) => <div {...selection.item(item.value)} class="demo-option"><span>{item.label}</span><span {...selection.itemIndicator(item.value)}><CheckGlyph /></span></div>}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

export function AutocompleteStory() { return <EditableSelectionStory mode="autocomplete" />; }
export function ComboboxStory() { return <EditableSelectionStory mode="combobox" />; }

export function AvatarStory() {
  const loaded = createAvatar({ id: "story-avatar-loaded", src: "/brand/clank-mark-192.png", defaultStatus: "loaded" });
  const fallback = createAvatar({ id: "story-avatar-fallback", defaultStatus: "error" });
  return (
    <div class="avatar-row">
      <div {...loaded.root()} class="demo-avatar large"><img {...loaded.image({ alt: "Clank mark" })} /></div>
      <div {...fallback.root()} class="demo-avatar"><span {...fallback.fallback()}>NC</span></div>
      <div class="avatar-copy"><strong>Nearby Coder</strong><span>Product designer</span></div>
    </div>
  );
}

export function BottomSheetStory() {
  const sheet = createBottomSheet({
    id: "story-bottom-sheet",
    modal: true,
    snapPoints: [0.48, 0.9],
    defaultSnapPoint: 0.48,
  });
  cleanup(sheet);
  const destinations = ["Production", "Preview", "Local development"];
  return <><button {...sheet.trigger()} class="demo-button">Choose environment</button><Show when={() => sheet.isMounted()}><Portal><div {...sheet.portal()} class="portal-root"><div {...sheet.backdrop()} class="demo-backdrop" /><div {...sheet.viewport()} class="bottom-sheet-viewport"><section {...sheet.dialog()} class="demo-bottom-sheet"><div {...sheet.swipeArea()} class="bottom-sheet-swipe"><span {...sheet.handle()} class="bottom-sheet-handle" /></div><div class="bottom-sheet-header"><div><span class="eyebrow">Deploy target</span><h3 {...sheet.title()}>Choose environment</h3><p {...sheet.description()}>A thumb-friendly surface with compact and expanded snap points.</p></div><button {...sheet.close()} class="dialog-close" aria-label="Close">×</button></div><div {...sheet.content()} class="bottom-sheet-content"><div class="bottom-sheet-variants"><button type="button" onClick={() => sheet.setSnapPoint(0.48)}>Compact</button><button type="button" onClick={() => sheet.setSnapPoint(0.9)}>Expanded</button></div><div class="bottom-sheet-options"><For each={destinations}>{(destination, index) => <button type="button" onClick={(event: Event) => sheet.hide("close-press", event)}><span>{index() === 0 ? "●" : index() === 1 ? "◐" : "○"}</span><span><strong>{destination}</strong><small>{index() === 0 ? "Live customer traffic" : index() === 1 ? "Pull request releases" : "Your current machine"}</small></span><i>→</i></button>}</For></div></div></section></div></div></Portal></Show></>;
}

export function ButtonStory() {
  const result = signal("");
  const primary = createButton({ id: "story-button-primary", onPress: () => { result.value = "Deploy started."; } });
  const secondary = createButton({ id: "story-button-secondary", onPress: () => { result.value = "Draft saved."; } });
  const danger = createButton({ id: "story-button-danger", onPress: () => { result.value = "Release removed."; } });
  const compact = createButton({ id: "story-button-compact", onPress: () => { result.value = "Preview copied."; } });
  const disabled = createButton({ id: "story-button-disabled", disabled: true });
  return <div class="demo-action-demo button-variant-demo"><div class="button-variant-group"><small>Tones</small><div class="button-row"><button {...primary.root()} class="demo-button">Deploy project</button><button {...secondary.root()} class="demo-button quiet">Save draft</button><button {...danger.root()} class="demo-button danger">Delete release</button></div></div><div class="button-variant-group"><small>Sizes and states</small><div class="button-row"><button {...compact.root()} class="demo-button compact" aria-label="Copy preview URL">⧉ <span>Copy URL</span></button><button {...disabled.root()} class="demo-button" disabled>Unavailable</button></div></div><p class="demo-action-status" role="status">{() => result.value}</p></div>;
}

export function CheckboxStory() {
  const checkbox = createCheckbox({ id: "story-checkbox", defaultChecked: true, name: "updates" });
  return (
    <label {...checkbox.root()} class="choice-row">
      <span class="demo-checkbox"><span {...checkbox.indicator({ keepMounted: true })}><CheckGlyph /></span></span>
      <span><strong>Deployment updates</strong><small>Receive a note when production changes.</small></span>
      <HiddenInput {...checkbox.input()} />
    </label>
  );
}

export function CheckboxGroupStory() {
  const items = ["email", "push", "digest"] as const;
  const group = createCheckboxGroup({ id: "story-checkbox-group", items, defaultValue: ["email", "digest"], name: "notifications" });
  const labels = { email: "Email", push: "Push notifications", digest: "Weekly digest" };
  return (
    <div {...group.root()} class="choice-stack">
      <label {...group.parent()} class="choice-row parent"><span class="demo-checkbox"><span {...group.parentIndicator({ keepMounted: true })}><CheckGlyph /></span></span><strong>All notifications</strong></label>
      <For each={items}>{(value) => <label {...group.item(value)} class="choice-row"><span class="demo-checkbox"><span {...group.indicator(value, { keepMounted: true })}><CheckGlyph /></span></span><span>{labels[value]}</span><HiddenInput {...group.input(value)} /></label>}</For>
    </div>
  );
}

export function CollapsibleStory() {
  const collapsible = createCollapsible({ id: "story-collapsible", defaultOpen: true });
  cleanup(collapsible);
  return (
    <div class="demo-collapsible">
      <button {...collapsible.trigger()} class="collapsible-trigger"><span><span class="status-dot" />Production environment</span><Chevron /></button>
      <Show when={() => collapsible.isPanelMounted()}><div {...collapsible.panel()} class="collapsible-panel"><dl><div><dt>Region</dt><dd>US West</dd></div><div><dt>Status</dt><dd>Healthy</dd></div><div><dt>Release</dt><dd>afb5f02</dd></div></dl></div></Show>
    </div>
  );
}

export function ContextMenuStory() {
  const menu = createContextMenu({
    id: "story-context-menu",
    items: [
      { value: "new", textValue: "New document" },
      { value: "duplicate", textValue: "Duplicate" },
      { value: "comments", textValue: "Show comments", kind: "checkbox" },
    ],
    defaultCheckedValues: ["comments"],
  });
  cleanup(menu);
  return (
    <>
      <div {...menu.target()} class="context-target" tabindex="0"><span class="context-cursor">↖</span><strong>Right-click this canvas</strong><small>Or press Shift + F10</small></div>
      <MenuLayer menu={menu} />
    </>
  );
}

export function DialogStory() {
  const dialog = createDialog({ id: "story-dialog", modal: "modal" });
  cleanup(dialog);
  return (
    <>
      <button {...dialog.trigger()} class="demo-button">Invite teammate</button>
      <Show when={() => dialog.isMounted()}>
        <Portal>
          <div {...dialog.portal()} class="portal-root"><div {...dialog.backdrop()} class="demo-backdrop" /><div {...dialog.viewport()} class="dialog-viewport"><div {...dialog.dialog()} class="demo-dialog"><button {...dialog.close()} class="dialog-close" aria-label="Close">×</button><span class="eyebrow">Workspace access</span><h3 {...dialog.title()}>Invite a teammate</h3><p {...dialog.description()}>They’ll receive a secure link to join your workspace.</p><label class="demo-label" for="dialog-email">Email address</label><input id="dialog-email" class="demo-input" type="email" placeholder="name@company.com" /><div class="dialog-actions"><button {...dialog.close()} class="demo-button quiet">Cancel</button><button {...dialog.close()} class="demo-button">Send invitation</button></div></div></div></div>
        </Portal>
      </Show>
    </>
  );
}

export function DrawerStory() {
  const drawer = createDrawer({ id: "story-drawer", direction: "right", modal: "modal", snapPoints: ["22rem", "36rem"] });
  cleanup(drawer);
  return (
    <>
      <button {...drawer.trigger()} class="demo-button">Open activity</button>
      <Show when={() => drawer.isMounted()}>
        <Portal><div {...drawer.portal()} class="portal-root"><div {...drawer.backdrop()} class="demo-backdrop" /><div {...drawer.viewport()} class="drawer-viewport right"><aside {...drawer.dialog()} class="demo-drawer"><div {...drawer.swipeArea()} class="drawer-handle" /><button {...drawer.close()} class="dialog-close" aria-label="Close">×</button><span class="eyebrow">Live project</span><h3 {...drawer.title()}>Recent activity</h3><p {...drawer.description()}>Changes from your team and connected agents.</p><div {...drawer.content()} class="timeline"><div><span>✓</span><p><strong>Release activated</strong><small>2 minutes ago</small></p></div><div><span>↗</span><p><strong>Custom domain verified</strong><small>18 minutes ago</small></p></div><div><span>+</span><p><strong>Teammate invited</strong><small>Yesterday</small></p></div></div></aside></div></div></Portal>
      </Show>
    </>
  );
}

export function FieldStory() {
  const field = createField({ id: "story-field", name: "workspace", defaultValue: "", required: true, validationMode: "onChange", validate: (value) => value.trim().length < 3 ? "Use at least three characters." : null });
  cleanup(field);
  return <div {...field.root()} class="demo-field-stack wide-control"><label {...field.label()} class="demo-label">Workspace name</label><input {...field.control()} class="demo-input" placeholder="Acme Studio" /><p {...field.description()} class="field-description">Shown to every member of your organization.</p><p {...field.error()} class="field-error">{() => field.errors.value[0] ?? ""}</p><span {...field.validity()} class="demo-status">{() => field.valid.value === true ? "Ready to use." : field.valid.value === false ? "Needs attention." : ""}</span></div>;
}

export function FieldsetStory() {
  const fieldset = createFieldset({ id: "story-fieldset", name: "deployment" });
  return <fieldset {...fieldset.root()} class="demo-fieldset"><legend {...fieldset.legend()}>Deployment target</legend><label class="choice-row"><input type="radio" name="target" checked /><span><strong>Production</strong><small>Visible at your public domain.</small></span></label><label class="choice-row"><input type="radio" name="target" /><span><strong>Preview</strong><small>Expires automatically after review.</small></span></label></fieldset>;
}

export function FormStory() {
  const result = signal("");
  const email = createField({ id: "story-form-email", name: "email", defaultValue: "", required: true, validate: (value) => value.includes("@") ? null : "Enter a valid email." });
  const role = createField({ id: "story-form-role", name: "role", defaultValue: "member" });
  const form = createFormFacade({ id: "story-form", onFormSubmit: async (values) => { result.value = `${values.email} was added as ${values.role}.`; } });
  const unregisterEmail = form.register("email", email);
  const unregisterRole = form.register("role", role);
  if (typeof document !== "undefined") onCleanup(() => { unregisterEmail(); unregisterRole(); form.dispose(); email.dispose(); role.dispose(); });
  return <form {...form.root()} class="demo-form"><div {...email.root()} class="demo-field-stack"><label {...email.label()} class="demo-label">Email</label><input {...email.control({ type: "email" })} class="demo-input" placeholder="ada@example.com" /><p {...email.error()} class="field-error">{() => email.errors.value[0] ?? ""}</p></div><div {...role.root()} class="demo-field-stack"><label {...role.label()} class="demo-label">Role</label><select {...role.control()} class="demo-input"><option value="member">Member</option><option value="admin">Administrator</option></select></div><button class="demo-button" type="submit">Create member</button><p class="demo-action-status" role="status">{() => result.value}</p></form>;
}

export function InputStory() {
  const input = createInput({ id: "story-input", name: "project", defaultValue: "Clank Design Studio" });
  return <div class="demo-field-stack wide-control"><label class="demo-label" for="story-input">Project name</label><div class="input-with-icon"><span>⌕</span><input {...input.root()} class="demo-input" /></div><small class="field-description">{() => `${input.value.value.length}/64 characters`}</small></div>;
}

function createStoryMenu(id: string) {
  return createMenu({
    id,
    items: [
      { value: "new", textValue: "New document" },
      { value: "duplicate", textValue: "Duplicate" },
      { value: "comments", textValue: "Show comments", kind: "checkbox" },
    ],
    defaultCheckedValues: ["comments"],
  });
}

export function MenuStory() {
  const menu = createStoryMenu("story-menu");
  cleanup(menu);
  return <><button {...menu.trigger()} class="demo-button quiet">Actions <Chevron /></button><MenuLayer menu={menu} /></>;
}

export function MenubarStory() {
  const menubar = createMenubar({
    id: "story-menubar",
    label: "Editor menu",
    items: [
      { value: "file", textValue: "File", items: [{ value: "new", textValue: "New file" }, { value: "open", textValue: "Open…" }] },
      { value: "edit", textValue: "Edit", items: [{ value: "undo", textValue: "Undo" }, { value: "redo", textValue: "Redo" }] },
      { value: "help", textValue: "Help", kind: "link", href: "https://docs.clank.run" },
    ],
  });
  cleanup(menubar);
  const file = menubar.menu("file");
  const edit = menubar.menu("edit");
  return <><div {...menubar.root()} class="demo-menubar"><div {...menubar.item("file")}><button {...menubar.trigger("file")} class="menubar-item">File</button></div><div {...menubar.item("edit")}><button {...menubar.trigger("edit")} class="menubar-item">Edit</button></div><div {...menubar.item("help")}><a {...menubar.link("help")} class="menubar-item">Help</a></div></div><MenuLayer menu={file}><button {...file.item("new")} class="demo-menu-item"><span>New file</span><kbd>⌘N</kbd></button><button {...file.item("open")} class="demo-menu-item"><span>Open…</span><kbd>⌘O</kbd></button></MenuLayer><MenuLayer menu={edit}><button {...edit.item("undo")} class="demo-menu-item"><span>Undo</span><kbd>⌘Z</kbd></button><button {...edit.item("redo")} class="demo-menu-item"><span>Redo</span><kbd>⇧⌘Z</kbd></button></MenuLayer></>;
}

export function MeterStory() {
  const meter = createMeter({ id: "story-meter", defaultValue: 68, min: 0, max: 100, format: { style: "percent", maximumFractionDigits: 0 } });
  return <div {...meter.root()} class="range-card"><div class="range-heading"><span {...meter.label()}>Storage used</span><strong {...meter.value()} /></div><div {...meter.track()} class="range-track"><div {...meter.indicator()} class="range-fill" /></div><small>6.8 GB of 10 GB</small></div>;
}

export function NavigationMenuStory() {
  const navigation = createNavigationMenu({
    id: "story-navigation",
    label: "Product",
    defaultValue: null,
    items: [
      { value: "product", textValue: "Product" },
      { value: "resources", textValue: "Resources" },
      { value: "pricing", textValue: "Pricing", kind: "link", href: "/" },
    ],
  });
  cleanup(navigation);
  return <><nav {...navigation.root()} class="demo-nav-menu"><div {...navigation.list()}><div {...navigation.item("product")}><button {...navigation.trigger("product")} class="nav-menu-item">Product <span {...navigation.icon("product")}><Chevron /></span></button></div><div {...navigation.item("resources")}><button {...navigation.trigger("resources")} class="nav-menu-item">Resources <span {...navigation.icon("resources")}><Chevron /></span></button></div><div {...navigation.item("pricing")}><a {...navigation.link("pricing")} class="nav-menu-item">Pricing</a></div></div></nav><Show when={() => navigation.isMounted()}><Portal><div {...navigation.portal()} class="portal-root"><div {...navigation.positioner()} class="floating-positioner"><div {...navigation.popup()} class="demo-floating nav-popup"><div {...navigation.viewport()}><div {...navigation.content("product")} class="nav-content"><a href="/"><strong>Deploy</strong><span>Atomic releases and rollback</span></a><a href="/"><strong>Observe</strong><span>Metrics, logs, and usage</span></a></div><div {...navigation.content("resources")} class="nav-content"><a href="https://docs.clank.run"><strong>Documentation</strong><span>Human and agent guides</span></a><a href="https://github.com/nearbycoder/clank.run"><strong>GitHub</strong><span>Open-source implementation</span></a></div></div></div></div></div></Portal></Show></>;
}

export function NumberFieldStory() {
  const number = createNumberField({ id: "story-number", name: "seats", defaultValue: 4, min: 1, max: 24 });
  return <div class="demo-field-stack"><label class="demo-label" for="story-number">Team seats</label><div {...number.group()} class="number-group"><button {...number.decrementButton()} class="number-button">−</button><input {...number.input()} class="number-input" /><button {...number.incrementButton()} class="number-button">+</button></div><small class="field-description">Adjust with arrow keys or the step buttons.</small></div>;
}

export function OTPFieldStory() {
  const otp = createOtpField({ id: "story-otp", length: 6, validationType: "numeric", name: "code" });
  return <div {...otp.root()} class="otp-wrap"><label class="demo-label">Verification code</label><div class="otp-inputs"><For each={[0, 1, 2]}>{(index) => <input {...otp.input(index, { ariaLabel: `Digit ${index + 1}` })} class="otp-input" />}</For><span {...otp.separator()} class="otp-separator">—</span><For each={[3, 4, 5]}>{(index) => <input {...otp.input(index, { ariaLabel: `Digit ${index + 1}` })} class="otp-input" />}</For></div><HiddenInput {...otp.hiddenInput()} /><small class="field-description">Paste all six digits into any field.</small></div>;
}

export function PaginationStory() {
  const pagination = createPagination({ id: "story-pagination", total: 247, pageSize: 10, initialPage: 7, siblingCount: 1 });
  cleanup(pagination);
  return <div class="pagination-demo"><div class="pagination-summary"><span {...pagination.status()} /><label>Rows <select {...pagination.pageSizeSelect()}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label></div><nav {...pagination.root({ label: "Project results" })} class="pagination-controls"><button {...pagination.previousButton()}><span aria-hidden="true">←</span><span class="pagination-long-label">Previous</span></button><div class="pagination-pages"><For each={pagination.pages}>{(item, index) => item === "ellipsis" ? <span {...pagination.ellipsis()} key={`ellipsis-${index()}`}>…</span> : <button {...pagination.pageButton(item)}>{item}</button>}</For></div><button {...pagination.nextButton()}><span class="pagination-long-label">Next</span><span aria-hidden="true">→</span></button></nav></div>;
}

export function PopoverStory() {
  const popover = createPopover({ id: "story-popover", side: "bottom", align: "start", sideOffset: 8 });
  cleanup(popover);
  return <><button {...popover.trigger()} class="demo-button quiet">Edit profile</button><PopupLayer popup={popover}><button {...popover.close()} class="dialog-close" aria-label="Close">×</button><span class="eyebrow">Quick edit</span><h3 {...popover.title()}>Profile details</h3><p {...popover.description()}>Update the information shown to teammates.</p><label class="demo-label" for="popover-name">Display name</label><input id="popover-name" class="demo-input" value="Nearby Coder" /><button {...popover.close()} class="demo-button full">Save changes</button></PopupLayer></>;
}

export function PreviewCardStory() {
  const preview = createPreviewCard({ id: "story-preview", side: "top", openDelay: 120, closeDelay: 120 });
  cleanup(preview);
  return <><p class="preview-copy">Every project includes a <a {...preview.trigger({ hover: true })} href="https://docs.clank.run/docs/per-app-mcp">per-app MCP server</a> that mirrors backend queries and mutations.</p><PopupLayer popup={preview} kind="preview-card"><span class="preview-logo">M</span><h3>MCP endpoint</h3><p>Typed tools, OAuth, resource-bound tokens, and live action parity.</p><small>docs.clank.run/docs/per-app-mcp</small></PopupLayer></>;
}

export function ProgressStory() {
  const progress = createProgress({ id: "story-progress", defaultValue: 72, min: 0, max: 100 });
  return <div {...progress.root()} class="range-card"><div class="range-heading"><span {...progress.label()}>Deploying release</span><strong {...progress.value()} /></div><div {...progress.track()} class="range-track"><div {...progress.indicator()} class="range-fill animated" /></div><small>Applying immutable migrations…</small></div>;
}

export function RadioStory() {
  const radio = createRadioGroup({ id: "story-radio", items: ["starter", "pro", "scale"], defaultValue: "pro", name: "plan" });
  const details = { starter: ["Starter", "For personal experiments"], pro: ["Pro", "For shipping side projects"], scale: ["Scale", "For growing teams"] };
  return <div {...radio.root()} class="radio-cards"><For each={["starter", "pro", "scale"] as const}>{(value) => <label {...radio.item(value)} class="radio-card"><span class="demo-radio"><span {...radio.indicator(value)} /></span><span><strong>{details[value][0]}</strong><small>{details[value][1]}</small></span><HiddenInput {...radio.input(value)} /></label>}</For></div>;
}

export function ScrollAreaStory() {
  const scroll = createScrollArea({ id: "story-scroll", label: "Release activity", scrollbarMode: "always" });
  cleanup(scroll);
  const events = ["Release activated", "Health check passed", "Artifact verified", "Migrations complete", "Upload accepted", "Build finished", "Security scan cleared", "Preview promoted", "Traffic switched", "Old release drained"];
  return <div {...scroll.root()} class="demo-scroll"><div {...scroll.viewport()} class="scroll-viewport"><div {...scroll.content()} class="scroll-content"><For each={events}>{(event, index) => <div class="scroll-event"><span>{index() < 2 ? "✓" : "·"}</span><p><strong>{event}</strong><small>{index() + 1} minute{index() ? "s" : ""} ago</small></p></div>}</For></div></div><div {...scroll.scrollbar("vertical")} class="scrollbar vertical"><div {...scroll.thumb("vertical")} class="scroll-thumb" /></div><div {...scroll.corner()} class="scroll-corner" /></div>;
}

export function SelectStory() {
  const compactOptions = optionItems.slice(0, 4);
  const select = createSelect({ id: "story-select", items: compactOptions, defaultValue: "design", name: "focus", presentation: "responsive" });
  cleanup(select);
  return <div class="demo-field-stack wide-control"><label {...select.label()} class="demo-label">Primary focus</label><button {...select.trigger()} class="select-trigger"><span {...select.valuePart({ placeholder: "Choose a focus" })} /><span {...select.icon()}><Chevron /></span></button><small class="field-description">Short list; use Combobox when filtering is useful.</small><For each={select.hiddenInputs()}>{(input) => <HiddenInput {...input} />}</For><Show when={() => select.isMounted()}><Portal><div {...select.portal()} class="portal-root selection-portal"><div {...select.backdrop()} class="selection-backdrop" /><div {...select.positioner()} class="floating-positioner selection-positioner"><div {...select.popup()} class="demo-floating selection-popup adaptive-selection-popup"><div class="selection-sheet-handle" aria-hidden="true"><span /></div><div class="selection-sheet-header"><div><small>Choose one</small><strong>Primary focus</strong></div><button type="button" class="selection-sheet-close" aria-label="Close options" onClick={(event: Event) => select.hide("close-press", event)}>×</button></div><div {...select.list()} class="selection-list"><For each={compactOptions} by="value">{(item) => <div {...select.item(item.value)} class="demo-option"><span {...select.itemText(item.value)}>{item.label}</span><span {...select.itemIndicator(item.value)}><CheckGlyph /></span></div>}</For></div></div></div></div></Portal></Show></div>;
}

export function SeparatorStory() {
  const horizontal = createSeparator({ id: "story-separator-horizontal" });
  const vertical = createSeparator({ id: "story-separator-vertical", orientation: "vertical", decorative: true });
  return <div class="separator-demo"><div><span>Profile</span><div {...horizontal.root()} class="demo-separator" /><span>Security</span></div><div class="separator-inline"><span>12 projects</span><div {...vertical.root()} class="demo-separator vertical" /><span>3 members</span><div {...vertical.root()} class="demo-separator vertical" /><span>Healthy</span></div></div>;
}

export function SliderStory() {
  const slider = createSlider({ id: "story-slider", name: "range", defaultValue: [24, 76], min: 0, max: 100, minGap: 8 });
  return <div {...slider.root()} class="slider-card"><div class="range-heading"><label {...slider.label()}>Traffic range</label><strong {...slider.valueText()}>{() => slider.values.value.join(" – ")}</strong></div><div {...slider.control()} class="demo-slider"><div {...slider.track()} class="slider-track"><div {...slider.indicator()} class="slider-indicator" /></div><For each={[0, 1]}>{(index) => <><div {...slider.thumb(index, { getAriaLabel: (value) => value ? "Maximum" : "Minimum" })} class="slider-thumb" /><HiddenInput {...slider.input(index)} /></>}</For></div><div class="slider-scale"><span>0</span><span>50</span><span>100</span></div></div>;
}

export function SwitchStory() {
  const enabled = createSwitch({ id: "story-switch-enabled", defaultChecked: true, name: "previews" });
  const disabled = createSwitch({ id: "story-switch-disabled", disabled: true });
  return <div class="choice-stack"><label {...enabled.root()} class="switch-row"><span><strong>Preview deployments</strong><small>Create an isolated URL for every pull request.</small></span><span class="demo-switch"><span {...enabled.thumb()} /></span><HiddenInput {...enabled.input()} /></label><label {...disabled.root()} class="switch-row"><span><strong>Automatic promotion</strong><small>Requires a production approval policy.</small></span><span class="demo-switch"><span {...disabled.thumb()} /></span><HiddenInput {...disabled.input()} /></label></div>;
}

export function TabsStory() {
  const tabs = createTabs({ id: "story-tabs", items: collectionItems, defaultValue: "overview" });
  cleanup(tabs);
  return <div {...tabs.root()} class="demo-tabs"><div {...tabs.list({ label: "Project sections" })} class="tabs-list"><For each={collectionItems} by="value">{(item) => <button {...tabs.tab(item.value)} class="tab-button">{item.textValue}</button>}</For><span {...tabs.indicator()} class="tabs-indicator" /></div><For each={collectionItems} by="value">{(item) => <Show when={() => tabs.isPanelMounted(item.value)}><div {...tabs.panel(item.value)} class="tab-panel"><strong>{item.textValue}</strong><p>{item.value === "overview" ? "Your project is healthy and serving the active release." : item.value === "details" ? "Runtime, region, domain, and database remain isolated." : "Every deploy and operator action is recorded."}</p></div></Show>}</For></div>;
}

export function ToastStory() {
  const toast = createToastProvider({ id: "story-toast", duration: 6_000, limit: 3 });
  cleanup(toast);
  const add = () => toast.manager.add({ title: "Deployment complete", description: "Release afb5f02 is live in production." });
  return <><button class="demo-button" type="button" onClick={add}>Show toast</button><Portal><div {...toast.portal()} class="portal-root"><div {...toast.viewport()} class="toast-viewport"><For each={toast.manager.visible} by="id">{(record) => <div {...toast.positioner(record.id)} class="toast-positioner"><article {...toast.root(record.id)} class="demo-toast"><div {...toast.content(record.id)}><strong {...toast.title(record.id)}>{record.title}</strong><p {...toast.description(record.id)}>{record.description}</p></div><button {...toast.close(record.id)} class="toast-close" aria-label="Dismiss">×</button></article></div>}</For></div></div></Portal></>;
}

export function ToggleStory() {
  const toggle = createToggle({ id: "story-toggle", defaultPressed: true });
  return <button {...toggle.root()} class="toggle-button"><strong>B</strong><span>Bold</span></button>;
}

export function ToggleGroupStory() {
  const group = createToggleGroup({ id: "story-toggle-group", items: ["left", "center", "right"], defaultValue: "left" });
  return <div {...group.root()} class="toggle-group" aria-label="Text alignment"><button {...group.item("left")} class="toggle-button" aria-label="Align left">≡</button><button {...group.item("center")} class="toggle-button" aria-label="Align center">≡</button><button {...group.item("right")} class="toggle-button" aria-label="Align right">≡</button></div>;
}

export function ToolbarStory() {
  const result = signal("");
  const toolbar = createToolbar({
    id: "story-toolbar",
    label: "Text formatting",
    items: [
      { value: "bold", textValue: "Bold", kind: "button", onPress: () => { result.value = "Bold applied."; } },
      { value: "italic", textValue: "Italic", kind: "button", onPress: () => { result.value = "Italic applied."; } },
      { value: "link", textValue: "Insert link", kind: "button", onPress: () => { result.value = "Link inserted."; } },
      { value: "separator", textValue: "Separator", kind: "separator" },
      { value: "search", textValue: "Search", kind: "input", type: "search", placeholder: "Find…" },
    ],
  });
  return <div class="demo-action-demo"><div {...toolbar.root()} class="demo-toolbar"><button {...toolbar.button("bold")} class="toolbar-button" aria-label="Bold"><strong aria-hidden="true">B</strong></button><button {...toolbar.button("italic")} class="toolbar-button" aria-label="Italic"><em aria-hidden="true">I</em></button><button {...toolbar.button("link")} class="toolbar-button" aria-label="Insert link"><span aria-hidden="true">↗</span></button><span {...toolbar.separator("separator")} class="demo-separator vertical" /><input {...toolbar.input("search")} class="toolbar-input" aria-label="Find" /></div><p class="demo-action-status" role="status">{() => result.value}</p></div>;
}

export function TooltipStory() {
  const provider = createTooltipProvider({ id: "story-tooltip-provider", delay: 120, closeDelay: 80 });
  const tooltip = provider.tooltip({ id: "story-tooltip", side: "top", sideOffset: 8 });
  cleanup(tooltip, provider);
  return <div {...provider.provider()}><button {...tooltip.trigger({ hover: true })} class="icon-button large" aria-label="Copy deployment URL">⧉</button><PopupLayer popup={tooltip} kind="tooltip"><span>Copy deployment URL</span></PopupLayer></div>;
}

export const COMPONENT_STORIES: Readonly<Record<string, () => unknown>> = Object.freeze({
  accordion: AccordionStory,
  "alert-dialog": AlertDialogStory,
  autocomplete: AutocompleteStory,
  avatar: AvatarStory,
  "bottom-sheet": BottomSheetStory,
  button: ButtonStory,
  checkbox: CheckboxStory,
  "checkbox-group": CheckboxGroupStory,
  collapsible: CollapsibleStory,
  combobox: ComboboxStory,
  "context-menu": ContextMenuStory,
  dialog: DialogStory,
  drawer: DrawerStory,
  field: FieldStory,
  fieldset: FieldsetStory,
  form: FormStory,
  input: InputStory,
  menu: MenuStory,
  menubar: MenubarStory,
  meter: MeterStory,
  "navigation-menu": NavigationMenuStory,
  "number-field": NumberFieldStory,
  "otp-field": OTPFieldStory,
  pagination: PaginationStory,
  popover: PopoverStory,
  "preview-card": PreviewCardStory,
  progress: ProgressStory,
  radio: RadioStory,
  "scroll-area": ScrollAreaStory,
  select: SelectStory,
  separator: SeparatorStory,
  slider: SliderStory,
  switch: SwitchStory,
  tabs: TabsStory,
  toast: ToastStory,
  toggle: ToggleStory,
  "toggle-group": ToggleGroupStory,
  toolbar: ToolbarStory,
  tooltip: TooltipStory,
});

export function ComponentStory(props: { slug: string }) {
  const Story = COMPONENT_STORIES[props.slug];
  return Story ? <Story /> : <div class="story-missing">This component story is not registered.</div>;
}
