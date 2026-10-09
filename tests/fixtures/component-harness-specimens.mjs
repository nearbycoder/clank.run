import { s } from '../../dist/ai.js';
import { signal, effect, onCleanup } from '../../dist/core.js';
import { h, Show, Portal, onMount } from '../../dist/dom.js';
import { createSwitch } from '../../dist/ui-controls.js';
import { createDialog } from '../../dist/ui-popups.js';
import { defineComponentSpecimen } from '../../dist/component-harness.js';
export const pulse = signal(0);
export const lifecycle = { created: 0, disposed: 0, activeEffects: 0, activeListeners: 0, reactions: 0, events: 0, trustedKeys: [] };
function resources() {
  lifecycle.created++; lifecycle.activeEffects++;
  effect(() => { pulse.value; lifecycle.reactions++; }); onCleanup(() => lifecycle.activeEffects--);
  onMount(() => {
    lifecycle.activeListeners++;
    const listener = () => lifecycle.events++;
    const keyboard = event => { if (event.isTrusted && lifecycle.trustedKeys.length < 50) lifecycle.trustedKeys.push(event.shiftKey && event.key === 'Tab' ? 'Shift+Tab' : event.key === ' ' ? 'Space' : event.key); };
    window.addEventListener('fixture-resource', listener); window.addEventListener('keydown', keyboard);
    return () => { lifecycle.activeListeners--; window.removeEventListener('fixture-resource', listener); window.removeEventListener('keydown', keyboard); };
  });
}
const toggleSteps = [
  { wait: { target: 'fixture-switch', state: { checked: false }, timeoutMs: 10000 } },
  { focus: 'fixture-switch' }, { expect: { focused: 'fixture-switch' } },
  { press: 'Enter' }, { expect: { target: 'fixture-switch', state: { checked: true } } },
  { press: 'Space' }, { expect: { target: 'fixture-switch', state: { checked: false } } },
  { press: 'ArrowDown' }, { expect: { focused: 'fixture-switch', noHorizontalOverflow: true } },
  { press: 'Tab' }, { expect: { focused: 'after-switch' } },
  { press: 'Shift+Tab' }, { expect: { focused: 'fixture-switch' } },
  { activate: 'lifecycle-check' }, { expect: { text: 'native keys: Enter, Space, ArrowDown, Tab, Shift+Tab' } },
];
export const toggle = defineComponentSpecimen({ name: 'toggle', label: 'Notifications switch', revision: 'toggle/1',
  props: s.object({ enabled: s.boolean() }), value: { enabled: false }, parts: { root: 'fixture-switch' },
  assertions: [{ target: 'fixture-switch', state: { checked: false, role: 'switch' } }, { noHorizontalOverflow: true }],
  journeys: [1280, 390].map(width => ({ name: 'Switch native keyboard '+width, start: '/?specimen=toggle&bare=1', viewport: { width, height: 844 }, steps: toggleSteps })),
  create(props) {
    resources(); const control = createSwitch({ id: 'fixture-switch', defaultChecked: props.enabled });
    return { view: h('div', { class: 'specimen' }, h('button', control.root({ nativeButton: true, agentLabel: 'Notifications' }), 'Notifications'),
      h('input', { ...control.input(), class: 'visually-hidden' }), h('button', { id: 'after-switch' }, 'After switch')),
      manifest: () => control.manifest(), dispose() { lifecycle.disposed++; } };
  },
});
const dialogSteps = [
  { wait: { target: 'open-details', state: { expanded: false }, timeoutMs: 10000 } },
  { focus: 'open-details' }, { press: 'Enter' },
  { wait: { target: 'details-popup', state: { role: 'dialog' } } },
  { expect: { focused: 'details-name' } }, { press: 'Tab' }, { expect: { focused: 'close-details' } },
  { press: 'Tab' }, { expect: { focused: 'details-name' } },
  { press: 'Shift+Tab' }, { expect: { focused: 'close-details' } },
  { press: 'Escape' }, { wait: { focused: 'open-details', target: 'open-details', state: { expanded: false } } },
  { expect: { noHorizontalOverflow: true } },
  { activate: 'lifecycle-check' }, { expect: { text: 'native keys: Enter, Tab, Tab, Shift+Tab, Escape' } },
];
export const dialog = defineComponentSpecimen({ name: 'dialog', label: 'Modal details', revision: 'dialog/1',
  props: s.object({ title: s.string() }), value: { title: 'Details' }, parts: { trigger: 'open-details', popup: 'details-popup' },
  assertions: [{ target: 'open-details', state: { expanded: false } }, { noHorizontalOverflow: true }],
  journeys: [1280, 390].map(width => ({ name: 'Dialog native focus '+width, start: '/?specimen=dialog&bare=1', viewport: { width, height: 844 }, steps: dialogSteps })),
  create(props) {
    resources(); const control = createDialog({ id: 'details' });
    return { view: h('div', { class: 'specimen' }, h('button', control.trigger({ id: 'open-details', agentId: 'open-details' }), 'Open details'),
      h(Show, { when: () => control.isMounted() }, () => h(Portal, {},
        h('div', { ...control.popup(), class: 'modal' }, h('h2', control.title(), props.title),
          h('label', { for: 'details-name' }, 'Name'), h('input', { id: 'details-name' }),
          h('button', control.close({ agentId: 'close-details', agentLabel: 'Close details' }), 'Close details'))))),
      manifest: () => control.manifest(), dispose() { lifecycle.disposed++; control.dispose(); } };
  },
});
export const specimens = [toggle, dialog];
