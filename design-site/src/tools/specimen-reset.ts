import { computed, onCleanup, signal, type Renderable } from "../../vendor/dom.js";

/** Own this inside ComponentView and render only its accessor inside the story root. */
export function createSpecimenReset(specimen: () => Renderable) {
  const revision = signal(0);
  const current = computed(() => {
    revision.value;
    return specimen();
  });
  let active = true;
  onCleanup(() => { active = false; });
  return {
    // A dynamic boundary disposes the previous component before mounting its replacement.
    // A keyed list would mount the new story before disposing the old one with the same IDs.
    // Stable identity between resets also prevents controller reads during mount/cleanup
    // from turning an ordinary story interaction into another remount.
    render: (): Renderable => current.value,
    reset(event: Event): void {
      if (!active) return;
      const button = event.currentTarget as HTMLElement | null;
      const next = revision.peek() + 1;
      revision.value = next;
      const restoreFocus = () => {
        if (active && revision.peek() === next && button?.isConnected) button.focus({ preventScroll: true });
      };
      restoreFocus();
      // Overlay disposal can queue focus restoration; the persistent reset button wins last.
      queueMicrotask(restoreFocus);
    },
  };
}
