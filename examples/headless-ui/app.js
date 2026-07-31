import { jsx as __clankJSX, Fragment as __clankFragment, expression as __clankExpression } from "/dist/index.js";
import { For, Portal, Show, render } from "@clank.run/framework/dom";
import { createAutocomplete, createCheckbox, createDialog, createNumberField, createSelect, createSlider, createTabs, createToastProvider, createTooltipProvider } from "@clank.run/framework/ui";
const choices = [
    {
        value: "signals",
        label: "Signals"
    },
    {
        value: "server",
        label: "Server rendering"
    },
    {
        value: "agents",
        label: "Agent contracts"
    }
];
const select = createSelect({
    id: "lab-select",
    name: "capability",
    items: choices,
    defaultValue: "signals"
});
const selectInputs = select.hiddenInputs();
const autocomplete = createAutocomplete({
    id: "lab-autocomplete",
    name: "search",
    items: choices,
    completionMode: "both",
    autoHighlight: true
});
const checkbox = createCheckbox({
    id: "lab-checkbox",
    name: "realtime",
    defaultChecked: true
});
const number = createNumberField({
    id: "lab-number",
    name: "copies",
    defaultValue: 2,
    min: 1,
    max: 12
});
const slider = createSlider({
    id: "lab-slider",
    name: "confidence",
    defaultValue: 72,
    min: 0,
    max: 100
});
const tabs = createTabs({
    id: "lab-tabs",
    defaultValue: "human",
    items: [
        {
            value: "human",
            textValue: "For people"
        },
        {
            value: "agent",
            textValue: "For agents"
        },
        {
            value: "server",
            textValue: "On the server"
        }
    ]
});
const dialog = createDialog({
    id: "lab-dialog"
});
const tooltipProvider = createTooltipProvider({
    id: "lab-tooltips",
    delay: 80,
    timeout: 250
});
const tooltip = tooltipProvider.tooltip({
    id: "lab-tooltip",
    side: "top",
    sideOffset: 8
});
const toast = createToastProvider({
    id: "lab-toasts",
    limit: 3,
    duration: 5_000
});
function SelectionCard() {
    return __clankJSX("section", {
        "class": "card",
        "aria-labelledby": "selection-heading"
    }, __clankJSX("h2", {
        "id": "selection-heading"
    }, "Selection"), __clankJSX("div", {
        "class": "stack"
    }, __clankJSX("label", {
        ...select.label(),
        "class": "field-label"
    }, "Primary capability"), __clankJSX("button", {
        ...select.trigger(),
        "class": "select-trigger",
        "data-testid": "select-trigger"
    }, __clankJSX("span", {
        ...select.valuePart({
            placeholder: "Choose one"
        })
    }), __clankJSX("span", {
        ...select.icon()
    }, "⌄")), __clankJSX(For, {
        "each": __clankExpression(()=>selectInputs)
    }, (props)=>__clankJSX("input", {
            ...props,
            "class": "native-projection"
        })), __clankJSX("label", {
        ...autocomplete.label(),
        "class": "field-label"
    }, "Search capabilities"), __clankJSX("div", {
        ...autocomplete.inputGroup(),
        "class": "row"
    }, __clankJSX("input", {
        ...autocomplete.input(),
        "class": "input",
        "placeholder": "Try “server”",
        "data-testid": "autocomplete-input"
    }), __clankJSX("button", {
        ...autocomplete.clear(),
        "class": "button"
    }, "Clear")), __clankJSX("span", {
        ...autocomplete.status(),
        "class": "status"
    })), __clankJSX(Show, {
        "when": __clankExpression(()=>select.isMounted)
    }, __clankJSX(Portal, {}, __clankJSX("div", {
        ...select.portal()
    }, __clankJSX("div", {
        ...select.positioner(),
        "class": "popup-positioner"
    }, __clankJSX("div", {
        ...select.popup(),
        "class": "popup"
    }, __clankJSX("div", {
        ...select.list()
    }, __clankJSX(For, {
        "each": __clankExpression(()=>choices),
        "by": "value"
    }, (choice)=>__clankJSX("div", {
            ...select.item(choice.value),
            "class": "option"
        }, __clankExpression(()=>choice.label))))))))), __clankJSX(Show, {
        "when": __clankExpression(()=>autocomplete.isMounted)
    }, __clankJSX(Portal, {}, __clankJSX("div", {
        ...autocomplete.portal()
    }, __clankJSX("div", {
        ...autocomplete.positioner(),
        "class": "popup-positioner"
    }, __clankJSX("div", {
        ...autocomplete.popup(),
        "class": "popup"
    }, __clankJSX("div", {
        ...autocomplete.list()
    }, __clankJSX(For, {
        "each": __clankExpression(()=>autocomplete.filteredItems),
        "by": "value",
        "fallback": __clankJSX("div", {
            ...autocomplete.empty(),
            "class": "option"
        }, "No matches")
    }, (choice)=>__clankJSX("div", {
            ...autocomplete.item(choice.value),
            "class": "option"
        }, __clankExpression(()=>choice.label))))))))));
}
function FormCard() {
    return __clankJSX("section", {
        "class": "card",
        "aria-labelledby": "form-heading"
    }, __clankJSX("h2", {
        "id": "form-heading"
    }, "Native forms"), __clankJSX("div", {
        "class": "stack"
    }, __clankJSX("label", {
        "class": "field-label",
        "for": "lab-number"
    }, "Copies"), __clankJSX("div", {
        ...number.group(),
        "class": "number-group"
    }, __clankJSX("button", {
        ...number.decrementButton(),
        "class": "number-button"
    }, "−"), __clankJSX("input", {
        ...number.input(),
        "class": "number-input",
        "data-testid": "number-input"
    }), __clankJSX("button", {
        ...number.incrementButton(),
        "class": "number-button"
    }, "+")), __clankJSX("button", {
        ...checkbox.root({
            nativeButton: true
        }),
        "class": "check",
        "data-testid": "realtime-checkbox"
    }, __clankJSX("span", {
        "class": "check-box"
    }, __clankJSX("span", {
        ...checkbox.indicator()
    }, "✓")), " Keep browsers synchronized "), __clankJSX("input", {
        ...checkbox.input(),
        "class": "native-projection"
    }), __clankJSX("label", {
        ...slider.label(),
        "class": "field-label"
    }, "Confidence: ", __clankExpression(()=>slider.value.value), "%"), __clankJSX("div", {
        ...slider.control(),
        "class": "slider"
    }, __clankJSX("div", {
        ...slider.track(),
        "class": "slider-track"
    }, __clankJSX("div", {
        ...slider.indicator(),
        "class": "slider-fill"
    })), __clankJSX("div", {
        ...slider.thumb(0),
        "class": "slider-thumb",
        "data-testid": "slider-thumb"
    }), __clankJSX("input", {
        ...slider.input(0),
        "class": "native-projection"
    }))));
}
function TabsCard() {
    const entries = [
        [
            "human",
            "Accessible native behavior, responsive state hooks, and complete keyboard interaction."
        ],
        [
            "agent",
            "Serializable manifests describe parts, actions, state, and side effects without scraping CSS."
        ],
        [
            "server",
            "Deterministic IDs, SSR-safe controllers, portals, and node-preserving hydration share one contract."
        ]
    ];
    return __clankJSX("section", {
        ...tabs.root(),
        "class": "card wide",
        "aria-labelledby": "tabs-heading"
    }, __clankJSX("h2", {
        "id": "tabs-heading"
    }, "One behavior contract"), __clankJSX("div", {
        ...tabs.list({
            labelledBy: "tabs-heading"
        }),
        "class": "tabs"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>entries)
    }, (entry)=>__clankJSX("button", {
            ...tabs.tab(entry[0]),
            "class": "tab"
        }, __clankExpression(()=>entry[0] === "human" ? "For people" : entry[0] === "agent" ? "For agents" : "On the server")))), __clankJSX(For, {
        "each": __clankExpression(()=>entries)
    }, (entry)=>__clankJSX(Show, {
            "when": ()=>tabs.isPanelMounted(entry[0])
        }, __clankJSX("div", {
            ...tabs.panel(entry[0]),
            "class": "panel"
        }, __clankJSX("p", {}, __clankExpression(()=>entry[1]))))));
}
function OverlayCard() {
    const announce = ()=>toast.manager.add({
            title: "Everything stayed in sync",
            description: `${select.selectedItems.value[0]?.label ?? "No capability"}, ${number.value.value ?? 0} copies, ${slider.value.value}% confidence.`
        });
    return __clankJSX("section", {
        ...tooltipProvider.provider(),
        "class": "card wide",
        "aria-labelledby": "overlay-heading"
    }, __clankJSX("h2", {
        "id": "overlay-heading"
    }, "Layers and notifications"), __clankJSX("p", {}, "Focus restoration, inert backgrounds, floating geometry, and live announcements are built in."), __clankJSX("div", {
        "class": "row"
    }, __clankJSX("button", {
        ...dialog.trigger({
            agentId: "open-dialog",
            agentLabel: "Open the accessible dialog"
        }),
        "class": "button primary",
        "data-testid": "dialog-trigger"
    }, "Open dialog"), __clankJSX("button", {
        ...tooltip.trigger(),
        "class": "button",
        "aria-label": "Inspect keyboard support",
        "data-testid": "tooltip-trigger"
    }, "Keyboard support"), __clankJSX("button", {
        "class": "button",
        "onClick": announce,
        "data-testid": "toast-trigger"
    }, "Create toast")), __clankJSX(Show, {
        "when": __clankExpression(()=>dialog.isMounted)
    }, __clankJSX(Portal, {}, __clankJSX("div", {
        ...dialog.portal()
    }, __clankJSX("div", {
        ...dialog.backdrop(),
        "class": "dialog-backdrop"
    }), __clankJSX("section", {
        ...dialog.popup(),
        "class": "dialog",
        "data-testid": "dialog"
    }, __clankJSX("h2", {
        ...dialog.title()
    }, "A real modal boundary"), __clankJSX("p", {
        ...dialog.description()
    }, "Tab stays inside, Escape closes, the background becomes inert, and focus returns to the trigger."), __clankJSX("div", {
        "class": "dialog-actions"
    }, __clankJSX("button", {
        ...dialog.close(),
        "class": "button"
    }, "Cancel"), __clankJSX("button", {
        ...dialog.close({
            agentId: "confirm-dialog",
            agentLabel: "Confirm the dialog"
        }),
        "class": "button primary",
        "onClick": announce
    }, "Confirm")))))), __clankJSX(Show, {
        "when": __clankExpression(()=>tooltip.isMounted)
    }, __clankJSX(Portal, {}, __clankJSX("div", {
        ...tooltip.portal()
    }, __clankJSX("div", {
        ...tooltip.positioner(),
        "class": "popup-positioner"
    }, __clankJSX("div", {
        ...tooltip.popup(),
        "class": "tooltip"
    }, "Clank controllers own each family’s documented keyboard, focus, dismissal, and RTL behavior."))))));
}
function ToastViewport() {
    return __clankJSX("div", {
        ...toast.provider()
    }, __clankJSX(Portal, {}, __clankJSX("div", {
        ...toast.portal()
    }, __clankJSX("div", {
        ...toast.viewport(),
        "class": "toast-viewport"
    }, __clankJSX(For, {
        "each": __clankExpression(()=>toast.manager.visible),
        "by": "id"
    }, (record)=>__clankJSX("article", {
            ...toast.root(record.id),
            "class": "toast"
        }, __clankJSX("div", {
            ...toast.content(record.id),
            "class": "toast-content"
        }, __clankJSX("div", {}, __clankJSX("strong", {
            ...toast.title(record.id),
            "class": "toast-title"
        }, __clankExpression(()=>record.title)), __clankJSX("p", {
            ...toast.description(record.id),
            "class": "toast-description"
        }, __clankExpression(()=>record.description))), __clankJSX("button", {
            ...toast.close(record.id),
            "class": "toast-close"
        }, "×"))))))));
}
function App() {
    return __clankJSX(__clankFragment, {}, __clankJSX("main", {
        "class": "shell"
    }, __clankJSX("p", {
        "class": "eyebrow"
    }, "Clank · dependency-free headless UI"), __clankJSX("h1", {}, "Behavior first. Style it your way."), __clankJSX("p", {
        "class": "lede"
    }, "This browser fixture uses the same controller props, native form projection, focus management, portals, manifests, and Tailwind-ready state hooks shipped in the framework."), __clankJSX("div", {
        "class": "grid"
    }, __clankJSX(SelectionCard, {}), __clankJSX(FormCard, {}), __clankJSX(TabsCard, {}), __clankJSX(OverlayCard, {}))), __clankJSX(ToastViewport, {}));
}
const root = document.querySelector("#app");
if (!root) throw new Error("Missing #app root.");
const dispose = render(root, __clankJSX(App, {}));
window.addEventListener("pagehide", ()=>{
    dispose();
    select.dispose();
    autocomplete.dispose();
    dialog.dispose();
    tooltipProvider.dispose();
    toast.dispose();
}, {
    once: true
});


//# sourceURL=/home/nearby/Sites/clank/examples/headless-ui/app.tsx