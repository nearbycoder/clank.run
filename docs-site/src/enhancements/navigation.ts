/** Mobile navigation behaves as a modal; the same sidebar stays a landmark on desktop. */
export function installNavigation() {
  const toggle = document.getElementById("nav-toggle");
  const scrim = document.getElementById("nav-scrim");
  const sidebar = document.getElementById("docs-sidebar");
  const dismiss = document.getElementById("nav-close");
  const compact = window.matchMedia("(max-width: 900px)");
  const background = [...document.querySelectorAll<HTMLElement>(".site-header, .main-content, .toc, .site-footer, .skip-link")];
  let open = false;
  let previousInert: boolean[] = [];

  const close = (restoreFocus = true) => {
    if (!open) return;
    open = false;
    document.body.removeAttribute("data-nav-open");
    toggle?.setAttribute("aria-expanded", "false");
    toggle?.setAttribute("aria-label", "Open documentation navigation");
    if (scrim) scrim.hidden = true;
    sidebar?.removeAttribute("role");
    sidebar?.removeAttribute("aria-modal");
    sidebar?.removeAttribute("aria-label");
    background.forEach((element, index) => { element.inert = previousInert[index]; });
    previousInert = [];
    if (restoreFocus && compact.matches) toggle?.focus({ preventScroll: true });
  };

  toggle?.addEventListener("click", () => {
    if (!compact.matches || !sidebar) return;
    if (open) return close();
    open = true;
    document.body.setAttribute("data-nav-open", "");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Close documentation navigation");
    if (scrim) scrim.hidden = false;
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
    sidebar.setAttribute("aria-label", "Documentation navigation");
    previousInert = background.map((element) => element.inert);
    background.forEach((element) => { element.inert = true; });
    (dismiss ?? sidebar).focus({ preventScroll: true });
  });
  dismiss?.addEventListener("click", () => { close(); });
  scrim?.addEventListener("click", () => { close(); });
  sidebar?.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) close(false);
  });
  compact.addEventListener("change", () => {
    const restore = open && document.activeElement === dismiss;
    close(false);
    if (restore) (sidebar?.querySelector<HTMLElement>('a[aria-current="page"]') ?? sidebar)?.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", (event) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab" && sidebar) {
      const controls = [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary, [tabindex="0"]')]
        .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]")
          && (!element.closest("details:not([open])") || element.matches("details:not([open]) > summary")));
      const first = controls[0] ?? sidebar;
      const last = controls.at(-1) ?? sidebar;
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  return { close, isOpen: () => open };
}
