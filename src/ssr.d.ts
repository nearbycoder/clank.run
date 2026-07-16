import { type Renderable } from "./dom.js";
export interface RenderStringOptions {
    markers?: boolean;
}
/** Renders Clank TSX/VNodes to escaped HTML without requiring a DOM. */
export declare function renderToString(view: Renderable, options?: RenderStringOptions): Promise<string>;
export interface RenderDocumentOptions extends RenderStringOptions {
    title?: string;
    lang?: string;
    head?: Renderable;
    rootId?: string;
    bodyClass?: string;
    state?: unknown;
    stateId?: string;
    scripts?: string[];
    stylesheets?: string[];
    /** CSP nonce applied to Clank's generated state and module script tags. */
    nonce?: string;
}
/** Renders a complete HTML document and safely embeds optional hydration data. */
export declare function renderDocument(view: Renderable, options?: RenderDocumentOptions): Promise<string>;
export declare function serializeState(value: unknown): string;
export declare function readState<Value = unknown>(id?: string, root?: ParentNode): Value | undefined;
