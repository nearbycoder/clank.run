import {
  For,
  Portal,
  Show,
  render,
} from "@clank.run/framework/dom";
import {
  createAutocomplete,
  createCheckbox,
  createDialog,
  createNumberField,
  createSelect,
  createSlider,
  createTabs,
  createToastProvider,
  createTooltipProvider,
} from "@clank.run/framework/ui";

const choices = [
  { value: "signals", label: "Signals" },
  { value: "server", label: "Server rendering" },
  { value: "agents", label: "Agent contracts" },
] as const;

const select = createSelect({
  id: "lab-select",
  name: "capability",
  items: choices,
  defaultValue: "signals",
});
const selectInputs = select.hiddenInputs();
const autocomplete = createAutocomplete({
  id: "lab-autocomplete",
  name: "search",
  items: choices,
  completionMode: "both",
  autoHighlight: true,
});
const checkbox = createCheckbox({ id: "lab-checkbox", name: "realtime", defaultChecked: true });
const number = createNumberField({ id: "lab-number", name: "copies", defaultValue: 2, min: 1, max: 12 });
const slider = createSlider({ id: "lab-slider", name: "confidence", defaultValue: 72, min: 0, max: 100 });
const tabs = createTabs({
  id: "lab-tabs",
  defaultValue: "human",
  items: [
    { value: "human", textValue: "For people" },
    { value: "agent", textValue: "For agents" },
    { value: "server", textValue: "On the server" },
  ],
});
const dialog = createDialog({ id: "lab-dialog" });
const tooltipProvider = createTooltipProvider({ id: "lab-tooltips", delay: 80, timeout: 250 });
const tooltip = tooltipProvider.tooltip({ id: "lab-tooltip", side: "top", sideOffset: 8 });
const toast = createToastProvider({ id: "lab-toasts", limit: 3, duration: 5_000 });

function SelectionCard() {
  return (
    <section class="card" aria-labelledby="selection-heading">
      <h2 id="selection-heading">Selection</h2>
      <div class="stack">
        <label {...select.label()} class="field-label">Primary capability</label>
        <button {...select.trigger()} class="select-trigger" data-testid="select-trigger">
          <span {...select.valuePart({ placeholder: "Choose one" })} />
          <span {...select.icon()}>⌄</span>
        </button>
        <For each={selectInputs}>{(props) => <input {...props} class="native-projection" />}</For>

        <label {...autocomplete.label()} class="field-label">Search capabilities</label>
        <div {...autocomplete.inputGroup()} class="row">
          <input {...autocomplete.input()} class="input" placeholder="Try “server”" data-testid="autocomplete-input" />
          <button {...autocomplete.clear()} class="button">Clear</button>
        </div>
        <span {...autocomplete.status()} class="status" />
      </div>

      <Show when={select.isMounted}>
        <Portal>
          <div {...select.portal()}>
            <div {...select.positioner()} class="popup-positioner">
              <div {...select.popup()} class="popup">
                <div {...select.list()}>
                  <For each={choices} by="value">
                    {(choice) => <div {...select.item(choice.value)} class="option">{choice.label}</div>}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>

      <Show when={autocomplete.isMounted}>
        <Portal>
          <div {...autocomplete.portal()}>
            <div {...autocomplete.positioner()} class="popup-positioner">
              <div {...autocomplete.popup()} class="popup">
                <div {...autocomplete.list()}>
                  <For each={autocomplete.filteredItems} by="value" fallback={<div {...autocomplete.empty()} class="option">No matches</div>}>
                    {(choice) => <div {...autocomplete.item(choice.value)} class="option">{choice.label}</div>}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </section>
  );
}

function FormCard() {
  return (
    <section class="card" aria-labelledby="form-heading">
      <h2 id="form-heading">Native forms</h2>
      <div class="stack">
        <label class="field-label" for="lab-number">Copies</label>
        <div {...number.group()} class="number-group">
          <button {...number.decrementButton()} class="number-button">−</button>
          <input {...number.input()} class="number-input" data-testid="number-input" />
          <button {...number.incrementButton()} class="number-button">+</button>
        </div>

        <button {...checkbox.root({ nativeButton: true })} class="check" data-testid="realtime-checkbox">
          <span class="check-box"><span {...checkbox.indicator()}>✓</span></span>
          Keep browsers synchronized
        </button>
        <input {...checkbox.input()} class="native-projection" />

        <label {...slider.label()} class="field-label">Confidence: {slider.value.value}%</label>
        <div {...slider.control()} class="slider">
          <div {...slider.track()} class="slider-track"><div {...slider.indicator()} class="slider-fill" /></div>
          <div {...slider.thumb(0)} class="slider-thumb" data-testid="slider-thumb" />
          <input {...slider.input(0)} class="native-projection" />
        </div>
      </div>
    </section>
  );
}

function TabsCard() {
  const entries = [
    ["human", "Accessible native behavior, responsive state hooks, and complete keyboard interaction."],
    ["agent", "Serializable manifests describe parts, actions, state, and side effects without scraping CSS."],
    ["server", "Deterministic IDs, SSR-safe controllers, portals, and node-preserving hydration share one contract."],
  ] as const;
  return (
    <section {...tabs.root()} class="card wide" aria-labelledby="tabs-heading">
      <h2 id="tabs-heading">One behavior contract</h2>
      <div {...tabs.list({ labelledBy: "tabs-heading" })} class="tabs">
        <For each={entries}>
          {(entry) => <button {...tabs.tab(entry[0])} class="tab">{entry[0] === "human" ? "For people" : entry[0] === "agent" ? "For agents" : "On the server"}</button>}
        </For>
      </div>
      <For each={entries}>
        {(entry) => (
          <Show when={() => tabs.isPanelMounted(entry[0])}>
            <div {...tabs.panel(entry[0])} class="panel"><p>{entry[1]}</p></div>
          </Show>
        )}
      </For>
    </section>
  );
}

function OverlayCard() {
  const announce = () => toast.manager.add({
    title: "Everything stayed in sync",
    description: `${select.selectedItems.value[0]?.label ?? "No capability"}, ${number.value.value ?? 0} copies, ${slider.value.value}% confidence.`,
  });
  return (
    <section {...tooltipProvider.provider()} class="card wide" aria-labelledby="overlay-heading">
      <h2 id="overlay-heading">Layers and notifications</h2>
      <p>Focus restoration, inert backgrounds, floating geometry, and live announcements are built in.</p>
      <div class="row">
        <button {...dialog.trigger({ agentId: "open-dialog", agentLabel: "Open the accessible dialog" })} class="button primary" data-testid="dialog-trigger">Open dialog</button>
        <button {...tooltip.trigger()} class="button" aria-label="Inspect keyboard support" data-testid="tooltip-trigger">Keyboard support</button>
        <button class="button" onClick={announce} data-testid="toast-trigger">Create toast</button>
      </div>

      <Show when={dialog.isMounted}>
        <Portal>
          <div {...dialog.portal()}>
            <div {...dialog.backdrop()} class="dialog-backdrop" />
            <section {...dialog.popup()} class="dialog" data-testid="dialog">
              <h2 {...dialog.title()}>A real modal boundary</h2>
              <p {...dialog.description()}>Tab stays inside, Escape closes, the background becomes inert, and focus returns to the trigger.</p>
              <div class="dialog-actions">
                <button {...dialog.close()} class="button">Cancel</button>
                <button {...dialog.close({ agentId: "confirm-dialog", agentLabel: "Confirm the dialog" })} class="button primary" onClick={announce}>Confirm</button>
              </div>
            </section>
          </div>
        </Portal>
      </Show>

      <Show when={tooltip.isMounted}>
        <Portal>
          <div {...tooltip.portal()}>
            <div {...tooltip.positioner()} class="popup-positioner">
              <div {...tooltip.popup()} class="tooltip">Clank controllers own each family’s documented keyboard, focus, dismissal, and RTL behavior.</div>
            </div>
          </div>
        </Portal>
      </Show>
    </section>
  );
}

function ToastViewport() {
  return (
    <div {...toast.provider()}>
      <Portal>
        <div {...toast.portal()}>
          <div {...toast.viewport()} class="toast-viewport">
            <For each={toast.manager.visible} by="id">
              {(record) => (
                <article {...toast.root(record.id)} class="toast">
                  <div {...toast.content(record.id)} class="toast-content">
                    <div>
                      <strong {...toast.title(record.id)} class="toast-title">{record.title}</strong>
                      <p {...toast.description(record.id)} class="toast-description">{record.description}</p>
                    </div>
                    <button {...toast.close(record.id)} class="toast-close">×</button>
                  </div>
                </article>
              )}
            </For>
          </div>
        </div>
      </Portal>
    </div>
  );
}

function App() {
  return (
    <>
      <main class="shell">
        <p class="eyebrow">Clank · dependency-free headless UI</p>
        <h1>Behavior first. Style it your way.</h1>
        <p class="lede">This browser fixture uses the same controller props, native form projection, focus management, portals, manifests, and Tailwind-ready state hooks shipped in the framework.</p>
        <div class="grid">
          <SelectionCard />
          <FormCard />
          <TabsCard />
          <OverlayCard />
        </div>
      </main>
      <ToastViewport />
    </>
  );
}

const root = document.querySelector("#app");
if (!root) throw new Error("Missing #app root.");
const dispose = render(root, <App />);
window.addEventListener("pagehide", () => {
  dispose();
  select.dispose();
  autocomplete.dispose();
  dialog.dispose();
  tooltipProvider.dispose();
  toast.dispose();
}, { once: true });
