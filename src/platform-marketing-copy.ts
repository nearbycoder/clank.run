/** Self-contained so the public page can authorize only this script with a CSP hash. */
export function installMarketingPromptCopy(): void {
  const source = document.getElementById("agent-setup-prompt-text");
  const status = document.getElementById("agent-prompt-copy-status");
  if (!source || !status) return;
  let currentRequest = 0;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-setup-prompt]")) {
    const label = button.textContent;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", async () => {
      if (pending) return;
      pending = true;
      const request = ++currentRequest;
      clearTimeout(timer);
      status.textContent = "";
      button.setAttribute("aria-busy", "true");
      let copied = false;
      try {
        if (source.textContent && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(source.textContent);
          copied = true;
        }
      } catch { /* Clipboard access is optional; the visible preview can be selected. */ }
      finally {
        pending = false;
        button.removeAttribute("aria-busy");
      }
      if (request !== currentRequest || !button.isConnected) return;
      let selected = false;
      if (!copied) {
        try {
          const selection = document.getSelection();
          const range = document.createRange();
          source.closest<HTMLElement>("pre")?.focus();
          range.selectNodeContents(source);
          selection?.removeAllRanges();
          selection?.addRange(range);
          selected = Boolean(source.textContent && selection?.toString() === source.textContent);
        } catch { /* Keep the readable prompt available when selection is unavailable. */ }
      }
      button.textContent = copied ? "Copied" : selected ? "Prompt selected" : "Copy unavailable";
      status.textContent = copied ? "Setup prompt copied. Paste it into your agent and replace the three bracketed values."
        : selected ? "Prompt selected. Use your browser’s Copy command, then paste it into your agent."
        : "Select the prompt below and use your browser’s Copy command.";
      timer = setTimeout(() => { button.textContent = label; }, 2500);
    });
  }
}
