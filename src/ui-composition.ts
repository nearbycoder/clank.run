import { computed, signal, type Cleanup, type Computed, type ReactiveSignal } from "./core.ts";
import {
  createContext,
  h,
  isVNode,
  onMount,
  provideContext,
  useContext,
  type ElementType,
  type Renderable,
  type VNode,
} from "./dom.ts";
import { mergeProps, resolveDirection, type Direction, type DirectionInput, type UiProps } from "./ui-foundation.ts";

export interface UiEnvironment {
  direction: Direction;
  nonce?: string;
}

const UiEnvironmentContext = createContext<UiEnvironment>({ direction: "ltr" });

export interface UiProviderProps {
  direction?: DirectionInput;
  nonce?: string;
  children: Renderable | Renderable[];
}

/** Supplies direction and CSP metadata to headless descendants without rendering a wrapper. */
export function UiProvider(props: UiProviderProps): Renderable {
  const parent = useContext(UiEnvironmentContext);
  provideContext(UiEnvironmentContext, {
    direction: resolveDirection(props.direction ?? parent.direction),
    nonce: props.nonce ?? parent.nonce,
  });
  return props.children;
}

export function DirectionProvider(props: { direction: Direction; children: Renderable | Renderable[] }): Renderable {
  return UiProvider({ direction: props.direction, children: props.children });
}

export function CSPProvider(props: { nonce: string; children: Renderable | Renderable[] }): Renderable {
  if (!/^[A-Za-z0-9+/_=-]{16,256}$/.test(props.nonce)) throw new TypeError("CSP nonce is invalid.");
  return UiProvider({ nonce: props.nonce, children: props.children });
}

export function useUiEnvironment(): UiEnvironment { return useContext(UiEnvironmentContext); }
export function useDirection(): Direction { return useUiEnvironment().direction; }
export function useCspNonce(): string | undefined { return useUiEnvironment().nonce; }

export type PartRenderer<State> = VNode | ((props: UiProps, state: State) => Renderable);
export interface RenderPartOptions<State = Record<string, never>> {
  defaultTag: ElementType;
  props?: UiProps;
  render?: PartRenderer<State>;
  state: State;
  children?: Renderable | Renderable[];
}

/**
 * Composes a headless part with a default tag, an existing VNode, or a render function while
 * preserving required handlers, refs, ARIA relationships, classes, and styles.
 */
export function renderPart<State>(options: RenderPartOptions<State>): Renderable {
  const children = options.children === undefined
    ? undefined
    : Array.isArray(options.children) ? options.children : [options.children];
  if (isVNode(options.render)) {
    const vnode = options.render;
    const props = mergeProps(vnode.props, options.props);
    const existing = vnode.props.children as Renderable[];
    return h(vnode.type, props, ...(children ?? existing));
  }
  if (typeof options.render === "function") {
    const props = children === undefined
      ? options.props ?? {}
      : { ...(options.props ?? {}), children };
    return options.render(props, options.state);
  }
  return h(options.defaultTag, options.props ?? {}, ...(children ?? []));
}

export type InputModality = "keyboard" | "pointer" | "virtual";
interface ModalityState { modality: InputModality; cleanup: Cleanup; users: number; }
const modalityStates = new WeakMap<Document, ModalityState>();

function acquireModality(document: Document): ModalityState {
  let state = modalityStates.get(document);
  if (state) { state.users++; return state; }
  state = { modality: "virtual", users: 1, cleanup: () => {} };
  const onKey = (event: KeyboardEvent) => {
    if (!event.metaKey && !event.altKey && !event.ctrlKey) state!.modality = "keyboard";
  };
  const onPointer = () => { state!.modality = "pointer"; };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  state.cleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
  };
  modalityStates.set(document, state);
  return state;
}

function releaseModality(document: Document): void {
  const state = modalityStates.get(document);
  if (!state || --state.users > 0) return;
  state.cleanup();
  modalityStates.delete(document);
}

export interface InteractionStateOptions { disabled?: boolean | (() => boolean); }
export interface InteractionStateController {
  readonly hovered: ReactiveSignal<boolean>;
  readonly focused: ReactiveSignal<boolean>;
  readonly focusVisible: ReactiveSignal<boolean>;
  readonly pressed: ReactiveSignal<boolean>;
  readonly disabled: Computed<boolean>;
  props(): UiProps;
}

/** Shared hover, focus-visible, and press state hooks for custom-rendered parts. */
export function createInteractionState(options: InteractionStateOptions = {}): InteractionStateController {
  const hovered = signal(false, { name: "ui.hovered" });
  const focused = signal(false, { name: "ui.focused" });
  const focusVisible = signal(false, { name: "ui.focusVisible" });
  const pressed = signal(false, { name: "ui.pressed" });
  const disabled = computed(() => typeof options.disabled === "function" ? options.disabled() : Boolean(options.disabled));
  let modality: ModalityState | undefined;
  let ownerDocument: Document | undefined;
  let mounts = 0;
  const reset = () => { hovered.value = false; focused.value = false; focusVisible.value = false; pressed.value = false; };
  const ensureModality = (document: Document) => {
    if (ownerDocument === document && modality) return;
    if (ownerDocument && modality) releaseModality(ownerDocument);
    ownerDocument = document;
    modality = acquireModality(document);
  };
  const releaseOwnedModality = () => {
    if (ownerDocument && modality) releaseModality(ownerDocument);
    ownerDocument = undefined;
    modality = undefined;
  };
  return {
    hovered, focused, focusVisible, pressed, disabled,
    props: () => ({
      "data-hovered": () => hovered.value ? "" : undefined,
      "data-focused": () => focused.value ? "" : undefined,
      "data-focus-visible": () => focusVisible.value ? "" : undefined,
      "data-pressed": () => pressed.value ? "" : undefined,
      "data-disabled": () => disabled.value ? "" : undefined,
      onPointerEnter: (event: PointerEvent) => { if (!disabled.peek() && event.pointerType !== "touch") hovered.value = true; },
      onPointerLeave: () => { hovered.value = false; pressed.value = false; },
      onPointerDown: (event: PointerEvent) => { if (!disabled.peek() && event.button === 0) pressed.value = true; },
      onPointerUp: () => { pressed.value = false; },
      onPointerCancel: () => { pressed.value = false; },
      onFocus: (event: FocusEvent) => {
        focused.value = true;
        const document = (event.currentTarget as Element).ownerDocument;
        ensureModality(document);
        focusVisible.value = modality!.modality !== "pointer";
      },
      onBlur: () => {
        focused.value = false;
        focusVisible.value = false;
        pressed.value = false;
        if (mounts === 0) releaseOwnedModality();
      },
      use: (element: Element): Cleanup => {
        const document = element.ownerDocument;
        mounts++;
        ensureModality(document);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          mounts = Math.max(0, mounts - 1);
          reset();
          if (mounts === 0 && ownerDocument === document) releaseOwnedModality();
        };
      },
    }),
  };
}

/** SSR-safe reactive media query. The supplied default is rendered until the component mounts. */
export function createMediaQuery(query: string, defaultMatches = false): ReactiveSignal<boolean> {
  if (!query.trim()) throw new TypeError("Media query cannot be empty.");
  const matches = signal(defaultMatches, { name: `media:${query}` });
  if (typeof window === "undefined") return matches;
  const attach = () => {
    const media = window.matchMedia(query);
    const update = () => { matches.value = media.matches; };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  };
  try {
    onMount(attach);
  } catch {
    attach();
  }
  return matches;
}
