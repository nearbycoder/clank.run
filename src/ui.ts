/**
 * Clank's dependency-free headless UI surface.
 *
 * Every primitive returns controller state plus prop getters for its semantic
 * parts. Spread those props onto native elements, compose them with renderPart,
 * and style only through ordinary classes, Tailwind, data attributes, or CSS
 * variables.
 */
export * from "./ui-foundation.ts";
export * from "./ui-composition.ts";
export {
  createOverlay,
  createFloating,
  createPresence,
  type OverlayDismissReason,
  type OverlayModality,
  type FocusTarget,
  type AutoFocusPolicy,
  type OverlayOptions,
  type OverlayController,
  type FloatingSide,
  type FloatingAlign,
  type FloatingStrategy,
  type VirtualAnchor,
  type FloatingAnchor,
  type FloatingOptions,
  type FloatingController,
  type PresenceState,
  type PresenceOptions,
  type PresenceController,
} from "./ui-overlay.ts";
export * from "./ui-popups.ts";
export * from "./ui-controls.ts";
export * from "./ui-selection.ts";
export * from "./ui-collections.ts";
export * from "./ui-fields.ts";
export * from "./ui-utilities.ts";
export * from "./ui-legacy.ts";
export * from "./ui-catalog.ts";
