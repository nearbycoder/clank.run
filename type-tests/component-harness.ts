import { s } from '../src/ai.ts';
import { h } from '../src/dom.ts';
import { createUiManifest } from '../src/index.ts';
import { defineComponentSpecimen, renderComponentSpecimen, hydrateComponentSpecimen, mountComponentSpecimen, mountComponentHarnessControls, exportComponentAssertions, type ComponentSpecimen, type ComponentHarness } from '../src/component-harness.ts';
import { defineJourney, type JourneyDriver, type JourneyKey } from '../src/journey.ts';
const props = s.object({ label: s.string(), count: s.number() });
const create = (value: Readonly<{ label: string; count: number }>) => ({ view: h('button', { id: 'counter' }, value.label),
  manifest: () => createUiManifest({ component: 'Counter', id: 'counter', state: { count: value.count }, parts: [{ name: 'root', role: 'button', required: true }], actions: [] }), dispose() {} });
const input = { name: 'counter', revision: '1', props, value: { label: 'Counter', count: 0 }, create,
  parts: { root: 'counter' }, assertions: [{ target: 'counter', state: { role: 'button' } }],
  journeys: [{ name: 'Keyboard', steps: [{ focus: 'counter' }, { press: 'Enter' as const }, { expect: { focused: 'counter', noHorizontalOverflow: true as const } }] }] };
const specimen: ComponentSpecimen<{ label: string; count: number }> = defineComponentSpecimen(input);
const exported: string = exportComponentAssertions(specimen); void exported;
async function contracts() {
  const root = document.createElement('div');
  const result = await renderComponentSpecimen(specimen);
  const harness: ComponentHarness = await hydrateComponentSpecimen(root, specimen, result.snapshot, { signal: new AbortController().signal });
  harness.reset(); harness.select(specimen); const report = await harness.check(); const ok: boolean | undefined = report?.ok; void ok;
  const phase: 'mounted' | 'hydrated' | 'disposed' = harness.snapshot().phase; void phase;
  mountComponentHarnessControls(document.createElement('aside'), harness, [specimen])(); harness.dispose();
  mountComponentSpecimen(root, specimen).dispose();
  // @ts-expect-error snapshots are immutable
  result.snapshot.fingerprint = 'different';
  // @ts-expect-error factory props are read-only
  defineComponentSpecimen({ ...input, create(value) { value.count++; return create(value); } });
  // @ts-expect-error schema requires numeric count
  defineComponentSpecimen({ ...input, value: { label: 'Counter', count: 'wrong' } });
  // @ts-expect-error synchronous factory contract
  defineComponentSpecimen({ ...input, create: async value => create(value) });
  // @ts-expect-error only registered branded definitions can be used
  mountComponentSpecimen(root, { name: 'forged', revision: '1', label: 'Forged', protocol: 'clank-component-specimen/1' });
  // @ts-expect-error cancellation requires an AbortSignal
  await hydrateComponentSpecimen(root, specimen, result.snapshot, { signal: true });
}
void contracts;
const key: JourneyKey = 'Shift+Tab'; void key;
defineJourney({ name: 'Focus', steps: [{ focus: 'counter' }, { press: 'Escape' }, { expect: { focused: 'counter', noHorizontalOverflow: true } }] });
// @ts-expect-error only bounded native keys are supported
defineJourney({ name: 'Bad key', steps: [{ press: 'Control+script' }] });
// @ts-expect-error overflow assertions express absence of overflow
defineJourney({ name: 'Bad layout', steps: [{ expect: { noHorizontalOverflow: false } }] });
const legacy: JourneyDriver = { navigate() {}, currentUrl: () => 'https://app.invalid', inspect: () => [], activate: () => false, input: () => false, visibleText: () => '', settle() {} };
const native: JourneyDriver = { ...legacy, focus: () => true, press() {}, focusedTarget: () => 'counter', layout: () => ({ clientWidth: 390, scrollWidth: 390 }) }; void native;
