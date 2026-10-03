/** Serialized into the local development proxy; never included by a production app. */
export function installDevelopmentUpdates(view) {
  const document = view.document, storageKey = `clank:dev:${view.location.pathname}${view.location.search}`;
  const registry = view[Symbol.for('clank.dev.state')] ??= { entries: new Map(), restored: new Map() };
  const eligible = node => node.matches('input[data-dev-preserve],textarea[data-dev-preserve],select[data-dev-preserve]') && !['password', 'file', 'hidden'].includes(node.type) && (node.getAttribute('autocomplete') ?? '').trim().toLowerCase() !== 'off' && !/password|cc-|one-time-code/.test((node.getAttribute('autocomplete') ?? '').toLowerCase());
  let saved;
  try { const raw = view.sessionStorage.getItem(storageKey); view.sessionStorage.removeItem(storageKey); if (raw && raw.length <= 65536) { const value = JSON.parse(raw); if (value.protocol === 'clank-dev-state/1' && Date.now() - value.at >= 0 && Date.now() - value.at < 30000 && Array.isArray(value.states) && Array.isArray(value.fields)) saved = value; } } catch {}
  const restore = () => {
    if (!saved) return;
    for (const entry of saved.states.slice(0, 100)) { if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue; const [key, value] = entry; try { if (registry.entries.has(key)) registry.entries.get(key).restore(value); else registry.restored.set(key, value); } catch {} }
    for (const field of saved.fields.slice(0, 200)) {
      const node = document.getElementById(field.id);
      if (!node || !eligible(node) || node.tagName !== field.tag || node.type !== field.type) continue;
      node.value = field.value; if ('checked' in node) node.checked = field.checked;
      if (field.focused) { node.focus({ preventScroll: true }); try { node.setSelectionRange(field.start, field.end); } catch {} }
    }
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) view.scrollTo(saved.x, saved.y); saved = undefined;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => view.requestAnimationFrame(restore), { once: true }); else view.requestAnimationFrame(restore);
  const reload = () => {
    const states = [];
    for (const [key, entry] of registry.entries) { if (states.length >= 100) break; try { states.push([key, entry.snapshot()]); } catch {} }
    const fields = [...document.querySelectorAll('[data-dev-preserve][id]')].filter(eligible).slice(0, 200).map(node => ({ id: node.id, tag: node.tagName, type: node.type, value: node.value, checked: node.checked, focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd }));
    try { const raw = JSON.stringify({ protocol: 'clank-dev-state/1', at: Date.now(), x: view.scrollX, y: view.scrollY, fields, states }); if (raw.length <= 65536) view.sessionStorage.setItem(storageKey, raw); } catch {}
    view.location.reload();
  };
  let updating = false, pending;
  const events = new view.EventSource('/_clank/dev-events');
  const update = async event => {
    let details; try { details = JSON.parse(event.data); } catch { reload(); return; }
    if (updating) { if (!pending || details.kind !== 'styles') pending = event; return; }
    updating = true;
    if (details.kind !== 'styles') { reload(); return; }
    const links = [...document.querySelectorAll('link[rel="stylesheet"][href]')].filter(link => new URL(link.href, view.location.href).origin === view.location.origin);
    if (!links.length) { reload(); return; }
    try {
      await Promise.all(links.map(link => new Promise((resolve, reject) => {
        const next = link.cloneNode(), url = new URL(link.href, view.location.href); url.searchParams.set('__clank_dev', String(details.revision)); next.href = url.href;
        const timer = view.setTimeout(() => { next.remove(); reject(new Error('stylesheet update timed out')); }, 5000);
        next.onload = () => { view.clearTimeout(timer); link.remove(); resolve(); }; next.onerror = () => { view.clearTimeout(timer); next.remove(); reject(new Error('stylesheet update failed')); };
        link.after(next);
      })));
      updating = false;
      if (pending) { const next = pending; pending = undefined; void update(next); }
    } catch { reload(); }
  };
  events.addEventListener('reload', update);
  return () => events.close();
}
export const DEVELOPMENT_CLIENT_SOURCE = `(${installDevelopmentUpdates.toString()})(globalThis);\n`;
