import { type Cleanup, type Computed, type ReactiveSignal } from "./core.js";
import { type ElementType, type Renderable, type VNode } from "./dom.js";
import { type Direction, type DirectionInput, type UiProps } from "./ui-foundation.js";
export interface UiEnvironment { direction: Direction; nonce?: string; }
export interface UiProviderProps { direction?: DirectionInput; nonce?: string; children: Renderable | Renderable[]; }
export declare function UiProvider(props: UiProviderProps): Renderable;
export declare function DirectionProvider(props: { direction: Direction; children: Renderable | Renderable[] }): Renderable;
export declare function CSPProvider(props: { nonce: string; children: Renderable | Renderable[] }): Renderable;
export declare function useUiEnvironment(): UiEnvironment;
export declare function useDirection(): Direction;
export declare function useCspNonce(): string | undefined;
export type PartRenderer<State> = VNode | ((props: UiProps, state: State) => Renderable);
export interface RenderPartOptions<State = Record<string, never>> { defaultTag: ElementType; props?: UiProps; render?: PartRenderer<State>; state: State; children?: Renderable | Renderable[]; }
export declare function renderPart<State>(options: RenderPartOptions<State>): Renderable;
export type InputModality = "keyboard" | "pointer" | "virtual";
export interface InteractionStateOptions { disabled?: boolean | (() => boolean); }
export interface InteractionStateController { readonly hovered: ReactiveSignal<boolean>; readonly focused: ReactiveSignal<boolean>; readonly focusVisible: ReactiveSignal<boolean>; readonly pressed: ReactiveSignal<boolean>; readonly disabled: Computed<boolean>; props(): UiProps; }
export declare function createInteractionState(options?: InteractionStateOptions): InteractionStateController;
export declare function createMediaQuery(query: string, defaultMatches?: boolean): ReactiveSignal<boolean>;
