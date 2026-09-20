import { createRoot } from "../../vendor/core.js";
import { UI_COMPONENT_CATALOG, UI_COMPONENT_FACTORIES, type UiCatalogEntry } from "../../vendor/ui.js";

export interface KeyboardGuideRow {
  key: string;
  action: string;
  when?: string;
}
export interface KeyboardGuide {
  slug: string;
  note: string;
  source: "controller" | "story" | "noninteractive";
  rows: readonly KeyboardGuideRow[];
}

const notes: Readonly<Record<string, string>> = {
  accordion: "Tab visits each trigger. This preview permits collapsing the open panel; there is no arrow-key navigation between accordion triggers.",
  "alert-dialog": "Open the alert with its button. The modal traps focus while open; Cancel and Delete are ordinary buttons. Outside presses do not dismiss this alert.",
  autocomplete: "Focus the search input and type to filter. This preview enables automatic highlighting and inline completion; Tab can accept an inline completion before leaving the field.",
  avatar: "No keyboard interaction. The image and fallback initials are presentational; they do not add a Tab stop.",
  "bottom-sheet": "Open the sheet with its button. This preview is modal. Compact and Expanded are native buttons; the drag handle has no keyboard shortcut for changing snap points.",
  button: "Tab to an enabled button, then activate it. The disabled button in this preview is excluded from normal keyboard focus.",
  checkbox: "Focus the checkbox and press Space. The custom checkbox follows checkbox semantics; Enter is not its toggle key.",
  "checkbox-group": "Tab visits the parent checkbox and individual choices. Space on the parent selects or clears the group; Space on a choice toggles just that choice.",
  collapsible: "The trigger is a native button. Expanding the panel makes its content available in normal document order.",
  combobox: "Open the standalone trigger, then type in the popup search input to filter workspaces. Arrow keys move the highlight; Enter selects it.",
  "context-menu": "First focus the canvas target. Shift+F10 or the Context Menu key opens its menu. The displayed command badges are labels, not registered application shortcuts.",
  dialog: "Open the dialog with its button. This preview is modal and keeps Tab focus inside until dismissed.",
  drawer: "Open the drawer with its button. This preview is modal; swipe gestures do not imply additional keyboard shortcuts.",
  field: "The field controller supplies labels and validation; the preview uses a native text input with standard browser text editing.",
  fieldset: "The fieldset itself has no keyboard shortcut or Tab stop. Its native radio inputs use browser radio-group navigation.",
  form: "Tab through the native fields and submit button. Submission validates the registered fields and focuses an invalid field when necessary.",
  input: "This is a native text input. Text entry, selection, clipboard commands, and cursor movement follow the browser and operating system.",
  menu: "Activate the trigger to open the menu, then navigate enabled items. The displayed command badges are labels, not registered application shortcuts. Submenu arrows only apply when submenus exist.",
  menubar: "The preview has File and Edit menus plus a Help link. Arrow keys move between top-level controls; an open menu also supports Up/Down and Enter/Space. Command badges do not register shortcuts.",
  meter: "No keyboard interaction. This read-only measurement does not add a Tab stop; assistive technology can read its label and current value.",
  "navigation-menu": "This preview uses a horizontal list. Open a trigger to visit its links; Enter follows a focused native link.",
  "number-field": "The seats input ranges from 1 to 24. Arrow keys step the value; modifier steps and Home/End depend on the configured steps and bounds.",
  "otp-field": "Tab into the six-slot numeric code. Typing advances through slots; pasting a code distributes accepted characters. Slot arrows respect text direction.",
  pagination: "Tab visits enabled page controls. Previous, Next, and page numbers are native buttons; ellipses and the status text are not interactive.",
  popover: "Open the trigger with Enter or Space. This preview is non-modal, so Tab follows normal document focus rather than trapping it in the popup.",
  "preview-card": "Focus the link to reveal the preview after its delay; Enter still follows that link. Preview cards are non-modal and never trap Tab focus.",
  progress: "No keyboard interaction. Progress is read-only status and does not add a Tab stop.",
  radio: "This preview is a horizontal single-choice group. Arrows move focus and selection together; disabled choices are skipped.",
  "scroll-area": "The viewport keeps native browser scrolling. The listed controller keys apply when the custom scrollbar has focus; this preview renders a vertical scrollbar.",
  select: "Focus and open the trigger, then move through enabled options. Enter selects the highlighted option. The preview selects one value.",
  separator: "No keyboard interaction. Semantic and decorative separators are not focusable controls and have no shortcuts.",
  slider: "Tab between the two thumbs. Values range from 0 to 100 with a minimum gap of 8; movement also respects the configured collision policy. Shift plus an arrow uses the large step.",
  switch: "Focus the enabled switch and press Enter or Space to change its state. The disabled example cannot be changed.",
  tabs: "This preview is horizontal with automatic activation: moving focus selects the tab. Vertical arrows and manual activation keys below describe alternative configurations.",
  toast: "Activate Show toast first. F6 moves to a visible notification; Escape dismisses the focused toast and Shift+Tab can return to the element active before F6.",
  toggle: "Tab to the Bold button. Enter or Space changes its pressed state; no formatting shortcut is registered.",
  "toggle-group": "This horizontal group uses one Tab stop. Arrows move focus without changing selection; activate the focused button to change its pressed state.",
  toolbar: "This preview is horizontal. Arrow navigation applies to toolbar controls; its text input retains native editing behavior. Vertical arrows apply only to a vertical toolbar.",
  tooltip: "Focus the named trigger to reveal its description after the delay. The tooltip itself is not interactive and never traps Tab focus.",
};

const tab = { key: "Tab / Shift+Tab", action: "Move focus forward or backward in document order." };
const activate = { key: "Enter / Space", action: "Activate the focused native button." };
const space = { key: "Space", action: "Toggle the focused enabled choice." };
const nativeRows: Readonly<Record<string, readonly KeyboardGuideRow[]>> = {
  button: [tab, activate],
  checkbox: [tab, space],
  "checkbox-group": [tab, space],
  field: [tab, { key: "Text editing keys", action: "Edit the focused native text input using browser behavior." }],
  fieldset: [tab, { key: "Arrow keys", action: "Move selection among the preview's native radio inputs." }, { key: "Space", action: "Select the focused native radio input." }],
  form: [tab, { ...activate, when: "On the Create member submit button." }],
  input: [tab, { key: "Text editing keys", action: "Edit, select, and move the cursor using browser and operating-system commands." }],
  radio: [
    { key: "Tab / Shift+Tab", action: "Enter or leave the group through its current focusable choice." },
    { key: "ArrowLeft / ArrowRight", action: "Move focus and selection, respecting text direction.", when: "Horizontal groups, including this preview." },
    { key: "ArrowUp / ArrowDown", action: "Move focus and selection.", when: "Vertical groups only; not this preview." },
    { key: "Home / End", action: "Select and focus the first or last enabled choice." },
    { key: "Space", action: "Select the focused enabled choice." },
  ],
  switch: [tab, { key: "Enter / Space", action: "Toggle the focused enabled switch." }],
  toggle: [tab, activate],
  "toggle-group": [
    { key: "Tab / Shift+Tab", action: "Enter or leave the group through its current focusable button." },
    { key: "ArrowLeft / ArrowRight", action: "Move focus, respecting text direction.", when: "Horizontal groups, including this preview." },
    { key: "ArrowUp / ArrowDown", action: "Move focus.", when: "Vertical groups only; not this preview." },
    { key: "Home / End", action: "Focus the first or last enabled button." },
    activate,
  ],
};

let sequence = 0;
const guides = new Map<string, KeyboardGuide>();

/** Read a detached contract without mounting a controller or retaining its resources. */
export function readControllerKeyboard(entry: UiCatalogEntry): Readonly<Record<string, string>> {
  const id = `studio-keyboard-guide-${entry.slug}-${++sequence}`;
  const options: Record<string, unknown> = { id, items: [{ value: "example", label: "Example", textValue: "Example" }] };
  if (entry.slug === "menubar") options.items = [{ value: "example", textValue: "Example", items: [{ value: "action", textValue: "Action" }] }];
  if (entry.slug === "otp-field") options.length = 6;
  if (entry.slug === "pagination") options.total = 30;
  let disposeRoot = () => {};
  let controller: { manifest(): { keyboard?: Readonly<Record<string, string>> }; dispose?: () => void } | undefined;
  try {
    return createRoot((dispose) => {
      disposeRoot = dispose;
      const factory = UI_COMPONENT_FACTORIES[entry.name] as (options: any) => NonNullable<typeof controller>;
      controller = factory(options);
      return Object.freeze({ ...controller.manifest().keyboard });
    });
  } finally {
    try { controller?.dispose?.(); } finally { disposeRoot(); }
  }
}

function condition(slug: string, key: string): string | undefined {
  if (key === "Tab" && ["alert-dialog", "bottom-sheet", "dialog", "drawer"].includes(slug)) return "While open in modal mode, as shown in this preview. Shift+Tab moves backward.";
  if (key === "Tab" && slug === "popover") return "Only with a trapped modal focus scope. This non-modal preview uses normal document Tab order.";
  if (["tabs", "toolbar"].includes(slug) && ["ArrowUp", "ArrowDown"].includes(key)) return "Vertical orientation only; this preview is horizontal.";
  if (slug === "tabs" && ["Enter", "Space"].includes(key)) return "Manual activation only; this preview activates tabs automatically.";
  if (["menu", "context-menu"].includes(slug) && ["ArrowLeft", "ArrowRight"].includes(key)) return "Only where a submenu is configured; this preview has no submenus.";
  if (slug === "number-field" && key === "Home") return "Requires min; this preview uses 1.";
  if (slug === "number-field" && key === "End") return "Requires max; this preview uses 24.";
  if (slug === "toast" && key === "F6") return "A visible toast must exist. Use Show toast first.";
  if (["select", "combobox", "autocomplete"].includes(slug) && key === "Enter") return "While the option list is open and an option is highlighted.";
  return undefined;
}

export function getKeyboardGuide(slug: string): KeyboardGuide | undefined {
  const entry = UI_COMPONENT_CATALOG.find((candidate) => candidate.slug === slug);
  if (!entry) return undefined;
  const cached = guides.get(slug);
  if (cached) return cached;
  const note = notes[slug];
  if (!note) throw new Error(`Missing keyboard guidance for ${entry.name}.`);
  const keyboard = readControllerKeyboard(entry);
  const rows = Object.entries(keyboard)
    // These fixed non-modal controllers inherit generic popup metadata, but never trap focus.
    .filter(([key]) => key !== "Tab" || !["preview-card", "tooltip"].includes(slug))
    .map(([key, action]) => ({ key, action, ...(condition(slug, key) ? { when: condition(slug, key) } : {}) }));
  const source = rows.length ? "controller" : nativeRows[slug] ? "story" : "noninteractive";
  const guide = Object.freeze({ slug, note, source, rows: Object.freeze((rows.length ? rows : nativeRows[slug] ?? []).map((row) => Object.freeze({ ...row }))) });
  guides.set(slug, guide);
  return guide;
}
