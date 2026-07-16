import type {
  Cleanup,
  Computed,
  ReactiveExpression,
  ReactiveSignal,
  Renderable,
} from "./index.js";

type ReactiveValue<Value> =
  | Value
  | ReactiveSignal<Value>
  | Computed<Value>
  | ReactiveExpression<Value>
  | (() => Value);

type ClassValue =
  | string
  | readonly ClassValue[]
  | Record<string, unknown>
  | null
  | undefined
  | false;

type StyleValue =
  | string
  | Record<string, ReactiveValue<string | number | null | undefined>>
  | null
  | undefined;

type Directive<ElementType extends Element> = (element: ElementType) => void | Cleanup;
type BindableSignal<Value> = { value: Value };

type ElementEvent<ElementType extends Element, EventType extends Event> =
  EventType & { readonly currentTarget: ElementType };

type CamelEventProps<ElementType extends Element> = {
  [Name in keyof GlobalEventHandlersEventMap as `on${Capitalize<Name & string>}`]?:
    (event: ElementEvent<ElementType, GlobalEventHandlersEventMap[Name]>) => unknown;
} & {
  [Name in keyof GlobalEventHandlersEventMap as `on${Capitalize<Name & string>}Capture`]?:
    (event: ElementEvent<ElementType, GlobalEventHandlersEventMap[Name]>) => unknown;
} & {
  [Name in keyof GlobalEventHandlersEventMap as `on${Capitalize<Name & string>}Once`]?:
    (event: ElementEvent<ElementType, GlobalEventHandlersEventMap[Name]>) => unknown;
} & {
  [Name in keyof GlobalEventHandlersEventMap as `on${Capitalize<Name & string>}Passive`]?:
    (event: ElementEvent<ElementType, GlobalEventHandlersEventMap[Name]>) => unknown;
};

type ColonEventProps<ElementType extends Element> = {
  [Name in keyof GlobalEventHandlersEventMap as `on:${Name & string}`]?:
    (event: ElementEvent<ElementType, GlobalEventHandlersEventMap[Name]>) => unknown;
};

type ElementStateProps<ElementType extends Element> = {
  [Key in keyof ElementType as
    Key extends string
      ? ElementType[Key] extends (...arguments_: never[]) => unknown
        ? never
        : Key
      : never
  ]?: ReactiveValue<ElementType[Key]>;
};

type DataAttributes = {
  [Name in `data-${string}`]?: ReactiveValue<string | number | boolean | null | undefined>;
};

type AriaAttributes = {
  [Name in `aria-${string}`]?: ReactiveValue<string | number | boolean | null | undefined>;
};

interface CommonAttributeAliases {
  accept?: ReactiveValue<string>;
  action?: ReactiveValue<string>;
  alt?: ReactiveValue<string>;
  autocomplete?: ReactiveValue<string>;
  autofocus?: ReactiveValue<boolean>;
  charset?: ReactiveValue<string>;
  colspan?: ReactiveValue<string | number>;
  contenteditable?: ReactiveValue<boolean | "true" | "false" | "plaintext-only">;
  crossorigin?: ReactiveValue<string>;
  datetime?: ReactiveValue<string>;
  enctype?: ReactiveValue<string>;
  for?: ReactiveValue<string>;
  formaction?: ReactiveValue<string>;
  height?: ReactiveValue<string | number>;
  max?: ReactiveValue<string | number>;
  maxlength?: ReactiveValue<string | number>;
  min?: ReactiveValue<string | number>;
  minlength?: ReactiveValue<string | number>;
  readonly?: ReactiveValue<boolean>;
  rowspan?: ReactiveValue<string | number>;
  step?: ReactiveValue<string | number>;
  tabindex?: ReactiveValue<string | number>;
  width?: ReactiveValue<string | number>;
}

interface ClankSpecialProps<ElementType extends Element> {
  key?: PropertyKey;
  children?: Renderable | Renderable[];
  class?: ReactiveValue<ClassValue>;
  className?: ReactiveValue<ClassValue>;
  classList?: ReactiveValue<Record<string, unknown>>;
  style?: ReactiveValue<StyleValue>;
  ref?: ReactiveSignal<ElementType | null> | ((element: ElementType) => void);
  use?: Directive<ElementType> | readonly Directive<ElementType>[];
  dangerouslySetInnerHTML?: ReactiveValue<{ __html: unknown }>;
  agentId?: ReactiveValue<string>;
  agentLabel?: ReactiveValue<string>;
  agentAction?: ReactiveValue<string>;
  agentDescription?: ReactiveValue<string>;
  agentHidden?: ReactiveValue<boolean>;
  intent?: ReactiveValue<string>;
}

type BindProps<ElementType extends Element> = {
  "bind:value"?: ElementType extends { value: infer Value } ? BindableSignal<Value> : never;
  "bind:checked"?: ElementType extends { checked: infer Value } ? BindableSignal<Value> : never;
  "bind:selected"?: ElementType extends { selected: infer Value } ? BindableSignal<Value> : never;
  "bind:selectedIndex"?: ElementType extends { selectedIndex: infer Value } ? BindableSignal<Value> : never;
};

type ClankElementProps<ElementType extends Element> =
  & Omit<
    ElementStateProps<ElementType>,
    | keyof ClankSpecialProps<ElementType>
    | keyof CamelEventProps<ElementType>
    | keyof CommonAttributeAliases
    | "className"
    | "style"
    | "children"
  >
  & ClankSpecialProps<ElementType>
  & BindProps<ElementType>
  & CamelEventProps<ElementType>
  & ColonEventProps<ElementType>
  & DataAttributes
  & AriaAttributes
  & CommonAttributeAliases;

type HTMLIntrinsicElements = {
  [Tag in keyof HTMLElementTagNameMap]: ClankElementProps<HTMLElementTagNameMap[Tag]>;
};

type SVGIntrinsicElements = {
  [Tag in Exclude<keyof SVGElementTagNameMap, keyof HTMLElementTagNameMap>]:
    ClankElementProps<SVGElementTagNameMap[Tag]>;
};

type CustomIntrinsicElements = {
  [Tag in `${string}-${string}`]: ClankElementProps<HTMLElement>;
};

declare global {
  namespace JSX {
    type Element = Renderable;
    interface ElementChildrenAttribute { children: {} }
    interface IntrinsicAttributes { key?: PropertyKey }
    type IntrinsicElements = HTMLIntrinsicElements & SVGIntrinsicElements & CustomIntrinsicElements;
  }
}

export {};
