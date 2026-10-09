import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { s } from '../dist/ai.js';
import { effect, signal, onCleanup } from '../dist/core.js';
import { h } from '../dist/dom.js';
import { createUiManifest } from '../dist/ui-foundation.js';
import { defineComponentSpecimen, exportComponentAssertions, renderComponentSpecimen, hydrateComponentSpecimen } from '../dist/component-harness.js';

const contract = state => createUiManifest({ component: 'Counter', id: 'counter', state,
  parts: [{ name: 'root', role: 'button', required: true }], actions: [] });
function input(extra = {}) {
  return { name: 'counter', revision: 'counter/1', props: s.object({ label: s.string(), count: s.number() }),
    value: { label: 'Counter', count: 0 }, parts: { root: 'counter' }, assertions: [{ target: 'counter', state: { role: 'button' } }],
    journeys: [{ name: 'Counter keyboard', steps: [{ focus: 'counter' }, { press: 'Enter' }, { expect: { focused: 'counter', noHorizontalOverflow: true } }] }],
    create: props => ({ view: h('button', { id: 'counter' }, props.label), manifest: () => contract({ count: props.count }), dispose() {} }),
    ...extra };
}

test('specimen contracts snapshot props, part mappings, callbacks and deterministic CLI assertions', async () => {
  let captured;
  const options = input({ create: props => { captured = props; return { view: h('button', { id: 'counter' }, props.label), manifest: () => contract({ count: props.count }), dispose() {} }; } });
  const specimen = defineComponentSpecimen(options), exported = exportComponentAssertions(specimen);
  options.value.label = 'Changed'; options.parts.root = 'other'; options.assertions[0].target = 'other'; options.journeys[0].steps[0].focus = 'other'; options.create = () => { throw Error('Wrong factory'); };
  options.props.parse = () => { throw Error('Changed schema must not reparse a captured fixture'); };
  const first = await renderComponentSpecimen(specimen), second = await renderComponentSpecimen(specimen);
  assert.equal(exportComponentAssertions(specimen), exported);
  assert.equal(first.html, second.html); assert.deepEqual(first.snapshot, second.snapshot);
  assert.match(first.html, /Counter/); assert.doesNotMatch(first.html, /Changed/);
  assert.equal(captured.label, 'Counter'); assert.ok(Object.isFrozen(captured));
  const data = JSON.parse(exported); assert.equal(data.protocol, 'clank-component-assertions/1');
  assert.equal(data.journeys[0].steps[0].focus, 'counter'); assert.equal('props' in data, false); assert.equal('startedAt' in data, false);
});

test('SSR scopes release fixture instances and real reactive subscriptions on success and failure', async () => {
  const pulse = signal(0), stats = { created: 0, disposed: 0, live: 0, reactions: 0 };
  const create = props => {
    stats.created++; stats.live++; onCleanup(() => stats.live--);
    effect(() => { pulse.value; stats.reactions++; });
    return { view: h('button', { id: 'counter' }, props.label), manifest: () => contract({ count: props.count }), dispose() { stats.disposed++; } };
  };
  const specimen = defineComponentSpecimen(input({ create }));
  await Promise.all([renderComponentSpecimen(specimen), renderComponentSpecimen(specimen)]);
  assert.equal(stats.live, 0); assert.equal(stats.created, 2); assert.equal(stats.disposed, 2);
  const reactions = stats.reactions; pulse.value++; assert.equal(stats.reactions, reactions);
  const failure = Error('Factory unavailable');
  const bad = defineComponentSpecimen(input({ create: props => { const instance = create(props); return { ...instance, manifest() { throw failure; } }; } }));
  await assert.rejects(renderComponentSpecimen(bad), error => error === failure);
  assert.equal(stats.live, 0); assert.equal(stats.created, stats.disposed); pulse.value++; assert.equal(stats.reactions, reactions + 1);
  const throwing = defineComponentSpecimen(input({ create: props => { create(props); throw failure; } }));
  await assert.rejects(renderComponentSpecimen(throwing), error => error === failure); assert.equal(stats.live, 0);
  const last = stats.reactions; pulse.value++; assert.equal(stats.reactions, last);
});

test('async SSR retains its own disposal until rendering completes and snapshots returned methods', async () => {
  let resolve, instance, disposed = 0;
  const pending = new Promise(done => resolve = done);
  const specimen = defineComponentSpecimen(input({ create: props => { instance = { view: pending, manifest: () => contract({ count: props.count }), dispose() { disposed++; } }; return instance; } }));
  const rendering = renderComponentSpecimen(specimen);
  while (!instance) await new Promise(done => setImmediate(done));
  assert.equal(disposed, 0); instance.dispose = () => { throw Error('Changed cleanup'); };
  resolve(h('button', { id: 'counter' }, 'Async')); await rendering; assert.equal(disposed, 1);
});

test('part contracts, protocols and finite JSON admissions fail before invalid fixture output is accepted', async () => {
  for (const extra of [{ unknown: true }, { value: { label: 'x', count: NaN } }, { value: { label: 'x'.repeat(70000), count: 0 } },
    { parts: { one: 'same', two: 'same' } }, { parts: { root: '<selector>' } }, { assertions: [] }, { journeys: [] },
    { journeys: Array.from({ length: 11 }, () => ({ name: 'too-many', steps: [{ inspect: 'ready' }] })) },
    { journeys: [{ name: 'bad key', steps: [{ press: 'arbitrary code' }] }] }]) assert.throws(() => defineComponentSpecimen(input(extra)));
  assert.throws(() => exportComponentAssertions({ protocol: 'clank-component-specimen/1', name: 'forged' }), /registered/);
  const missing = defineComponentSpecimen(input({ parts: {} })); await assert.rejects(renderComponentSpecimen(missing), /Required UI parts/);
  const absent = defineComponentSpecimen(input({ parts: { absent: 'counter' } })); await assert.rejects(renderComponentSpecimen(absent), /Mapped specimen part/);
  const unsupported = defineComponentSpecimen(input({ create: () => ({ view: null, manifest: () => ({ ...contract({}), protocol: 'future/2' }), dispose() {} }) }));
  await assert.rejects(renderComponentSpecimen(unsupported), /Invalid specimen UI/);
});

test('malformed asynchronous factory and manifest results are rejected without escaped rejections', async () => {
  const badFactory = defineComponentSpecimen(input({ create: () => Promise.reject(Error('Factory failed')) }));
  await assert.rejects(renderComponentSpecimen(badFactory), /synchronously/);
  let disposed = 0;
  const badManifest = defineComponentSpecimen(input({ create: () => ({ view: null, manifest: () => Promise.reject(Error('Manifest failed')), dispose() { disposed++; } }) }));
  await assert.rejects(renderComponentSpecimen(badManifest), /finite JSON/);
  await new Promise(done => setImmediate(done)); assert.equal(disposed, 1);
});

test('SSR escapes fixture values and bounds output while releasing its instance', async () => {
  const escaped = defineComponentSpecimen(input({ value: { label: '<script>window.secret=1</script>', count: 0 } }));
  const output = await renderComponentSpecimen(escaped); assert.match(output.html, /&lt;script&gt;/); assert.doesNotMatch(output.html, /<script>/i);
  let disposed = 0;
  const huge = defineComponentSpecimen(input({ create: () => ({ view: 'x'.repeat(256 * 1024 + 1), manifest: () => contract({}), dispose() { disposed++; } }) }));
  await assert.rejects(renderComponentSpecimen(huge), /SSR output/); assert.equal(disposed, 1);
});

test('pending hydration releases its original document after root adoption or detachment', async () => {
  let created = 0;
  const specimen = defineComponentSpecimen(input({ create: value => { created++; return input().create(value); } }));
  const { snapshot } = await renderComponentSpecimen(specimen); created = 0;
  let connected = true;
  const document = { defaultView: {}, documentElement: { contains: () => connected } };
  const root = { ownerDocument: document, nodeType: 1 };
  const mismatch = { ...snapshot, fingerprint: '0'.repeat(64) };
  for (const mode of ['adopt', 'detach']) {
    const pending = hydrateComponentSpecimen(root, specimen, snapshot);
    if (mode === 'adopt') root.ownerDocument = { defaultView: {} }; else connected = false;
    await assert.rejects(pending, /root changed/);
    root.ownerDocument = document; connected = true;
    await assert.rejects(hydrateComponentSpecimen(root, specimen, mismatch), /revision does not match/);
  }
  assert.equal(created, 0, 'changed roots and invalid snapshots never execute the instance factory');
});

test('cancelled hydration cannot release a newer reservation in the same document', async () => {
  const specimen = defineComponentSpecimen(input()), { snapshot } = await renderComponentSpecimen(specimen);
  const document = { defaultView: {}, documentElement: { contains: () => true } }, root = { ownerDocument: document, nodeType: 1 };
  const controller = new AbortController(), first = hydrateComponentSpecimen(root, specimen, snapshot, { signal: controller.signal });
  controller.abort();
  const second = hydrateComponentSpecimen(root, specimen, { ...snapshot, fingerprint: '0'.repeat(64) });
  await assert.rejects(first, /aborted/);
  await assert.rejects(second, /revision does not match/, 'late cancellation leaves the replacement reservation intact');
  await assert.rejects(hydrateComponentSpecimen(root, specimen, snapshot, { signal: controller.signal }), /aborted/);
});

test('the browser fixture serves only prebuilt specimen pages and never reflects query state', async () => {
  const child = spawn(process.execPath, [new URL('./fixtures/component-harness-browser.mjs', import.meta.url).pathname], { env: { ...process.env, CLANK_HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = once(child, 'exit');
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Fixture did not start')), 5000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once('error', fail); child.once('exit', () => fail(Error('Fixture exited before startup')));
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
  }).catch(async error => { child.kill(); await stopped; throw error; });
  try {
    const ordinary = await (await fetch(url)).text();
    const injected = await (await fetch(url+'/?mode='+encodeURIComponent('</ScRiPt><img src=x onerror=alert(1)>'))).text();
    assert.equal(injected, ordinary, 'unknown modes select static default content');
    const unknown = await (await fetch(url+'/?specimen='+encodeURIComponent('<svg onload=alert(1)>'))).text();
    assert.equal(unknown, ordinary, 'unknown specimen names select the static default');
    const adoption = await (await fetch(url+'/?mode=adopt')).text(); assert.notEqual(adoption, ordinary); assert.ok(adoption.includes('"mode":"adopt"'));
    const response = await fetch(url+'/assertions.json?specimen=dialog'); assert.equal(response.status, 200); assert.equal((await response.json()).specimen, 'dialog');
  } finally { child.kill(); await stopped; }
});
