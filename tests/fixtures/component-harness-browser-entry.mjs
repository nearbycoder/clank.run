import { readState } from '../../dist/ssr.js';
import { hydrateComponentSpecimen, mountComponentSpecimen, mountComponentHarnessControls } from '../../dist/component-harness.js';
import { specimens, lifecycle, pulse } from './component-harness-specimens.mjs';
const state = readState(), root = document.querySelector('#specimen-root'), original = root.firstElementChild;
const specimen = specimens.find(entry => entry.name === state.name);
let harness, rejectedBeforeCreate = false, staleReport = 'untested';
if (state.mode === 'abort') {
  const controller = new AbortController();
  const pending = hydrateComponentSpecimen(root, specimen, state.snapshot, { signal: controller.signal });
  controller.abort();
  harness = mountComponentSpecimen(root, specimen);
  try { await pending; } catch { rejectedBeforeCreate = lifecycle.created === 1; }
} else if (state.mode === 'adopt') {
  const parent = root.parentNode, next = root.nextSibling;
  const pending = hydrateComponentSpecimen(root, specimen, state.snapshot);
  document.implementation.createHTMLDocument('Disposable').body.append(root);
  try { await pending; } catch { rejectedBeforeCreate = lifecycle.created === 0; }
  parent.insertBefore(root, next); harness = mountComponentSpecimen(root, specimen);
} else if (state.mode === 'wrong-revision') {
  const snapshot = { ...state.snapshot, fingerprint: (state.snapshot.fingerprint[0] === '0' ? '1' : '0') + state.snapshot.fingerprint.slice(1) };
  try { await hydrateComponentSpecimen(root, specimen, snapshot); } catch { rejectedBeforeCreate = lifecycle.created === 0; }
  harness = mountComponentSpecimen(root, specimen);
} else harness = await hydrateComponentSpecimen(root, specimen, state.snapshot);
const proof = document.querySelector('#proof');
const preserved = root.firstElementChild === original;
const update = () => { const snapshot = harness.snapshot(); proof.textContent = 'SSR node preserved: '+preserved+'; phase: '+snapshot.phase+'; active effects: '+lifecycle.activeEffects+'; active listeners: '+lifecycle.activeListeners+'; created: '+lifecycle.created+'; disposed: '+lifecycle.disposed+'; hydration mismatches: '+snapshot.hydration.length+'; reactions: '+lifecycle.reactions+'; events: '+lifecycle.events+'; rejected before create: '+rejectedBeforeCreate+'; stale report: '+staleReport+'; native keys: '+lifecycle.trustedKeys.join(', ')+'; client width: '+document.documentElement.clientWidth+'; scroll width: '+document.documentElement.scrollWidth; };
let disposeControls;
if (document.querySelector('#controls')) disposeControls = mountComponentHarnessControls(document.querySelector('#controls'), harness, specimens);
document.querySelector('#lifecycle-check')?.addEventListener('click', update);
document.querySelector('#pulse-fixture')?.addEventListener('click', () => { pulse.value++; dispatchEvent(new Event('fixture-resource')); update(); });
document.querySelector('#remove-controls')?.addEventListener('click', () => { disposeControls?.(); update(); });
document.querySelector('#check-across-reset')?.addEventListener('click', async () => { const pending = harness.check(); harness.reset(); staleReport = await pending === null ? 'discarded' : 'accepted'; update(); });
document.querySelector('#check-across-disposal')?.addEventListener('click', async () => { const pending = harness.check(); disposeControls?.(); harness.dispose(); staleReport = await pending === null ? 'discarded' : 'accepted'; update(); });
update();
addEventListener('pagehide', () => { disposeControls?.(); harness.dispose(); }, { once: true });
