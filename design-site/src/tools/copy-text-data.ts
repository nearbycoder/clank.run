export async function copyRenderedText(text: string, preview: () => HTMLElement | null, clipboard?: Pick<Clipboard, "writeText">, current: () => boolean = () => true): Promise<"copied" | "selected" | "unavailable" | "stale"> {
  if (clipboard) {
    try { await clipboard.writeText(text); return current() ? "copied" : "stale"; } catch {}
  }
  if (!current()) return "stale";
  const node = preview();
  if (!node?.isConnected || node.textContent !== text) return "unavailable";
  try {
    const selection = node.ownerDocument.getSelection();
    if (!selection) return "unavailable";
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    node.closest<HTMLElement>("pre[tabindex]")?.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    return "selected";
  } catch { return "unavailable"; }
}
