/** Browser preferences are optional: blocked storage must never stop document reading. */
export function readLocalValue(key: string, maximumLength = 8192): unknown {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.length <= maximumLength ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

export function writeLocalValue(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private or full storage is fine. */ }
}

export function removeLocalValue(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* The current page still clears its visible history. */ }
}
