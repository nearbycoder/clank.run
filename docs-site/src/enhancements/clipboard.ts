const installedButtons = new WeakSet<HTMLButtonElement>();
let activeRequest = 0;

function copySource(button: HTMLButtonElement): HTMLElement | null {
  if (button.hasAttribute("data-copy-code")) return button.closest("figure")?.querySelector<HTMLElement>("pre code") ?? null;
  const value = button.dataset.copyText;
  return [...(button.parentElement?.querySelectorAll<HTMLElement>("code") ?? [])]
    .find((element) => element.textContent === value) ?? null;
}

function selectSource(source: HTMLElement): boolean {
  try {
    const selection = document.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(source);
    source.closest<HTMLElement>("pre[tabindex]")?.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString() === source.textContent;
  } catch {
    return false;
  }
}

/** Copy rendered text, or select that same text for the browser's Copy command. */
export function installCopyControls(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-copy-code], [data-copy-text]");
  if (!buttons.length) return;
  let status = document.getElementById("docs-copy-status");
  if (!status) {
    status = document.createElement("span");
    status.id = "docs-copy-status";
    status.className = "visually-hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    document.body.append(status);
  }

  for (const button of buttons) {
    if (installedButtons.has(button)) continue;
    installedButtons.add(button);
    const label = button.textContent ?? "Copy";
    const accessibleLabel = button.getAttribute("aria-label");
    let pending = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const resetLabel = () => {
      button.textContent = label;
      if (accessibleLabel === null) button.removeAttribute("aria-label");
      else button.setAttribute("aria-label", accessibleLabel);
    };
    button.addEventListener("click", async () => {
      if (pending) return;
      pending = true;
      const request = ++activeRequest;
      clearTimeout(resetTimer);
      resetLabel();
      status.textContent = "";
      button.setAttribute("aria-busy", "true");
      const source = copySource(button);
      const value = source?.textContent;
      let copied = false;
      try {
        if (value && typeof navigator.clipboard?.writeText === "function") {
          await navigator.clipboard.writeText(value);
          copied = true;
        }
      } catch { /* Clipboard permissions are optional; selection remains available. */ }
      finally {
        pending = false;
        button.removeAttribute("aria-busy");
      }
      // An older permission request must not steal focus or replace newer feedback.
      if (request !== activeRequest || !button.isConnected) return;
      const selected = !copied && Boolean(value && source?.isConnected && selectSource(source));
      const message = copied ? "Text copied to clipboard."
        : selected ? "Text selected. Use your browser’s Copy command to copy it."
        : "Could not copy or select the text. Select it manually and use your browser’s Copy command.";
      button.textContent = copied ? "Copied" : selected ? "Selected" : "Copy unavailable";
      button.setAttribute("aria-label", message);
      status.textContent = message;
      resetTimer = setTimeout(resetLabel, 1800);
    });
  }
}
