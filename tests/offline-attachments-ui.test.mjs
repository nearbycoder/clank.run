import test from 'node:test';
import assert from 'node:assert/strict';
import { mountOfflineAttachmentQueue } from '../dist/offline-attachments.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
// Model the browser focus loss caused by disabling/removing a focused control.
// Actual keyboard acceptance is exercised separately in the native HTTP fixture.
class Element {
  constructor(tag, document) { Object.assign(this, { tag, ownerDocument: document, childNodes: [], style: {}, dataset: {}, attributes: new Map(), ownText: '', isDisabled: false }); }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
  contains(node) { return this === node || this.childNodes.some(child => child.contains(node)); }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { for (const node of this.childNodes) node.remove(); this.childNodes = []; this.ownText = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  get disabled() { return this.isDisabled; }
  set disabled(value) { this.isDisabled = value; if (value && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  focus() { if (this.isConnected && !this.disabled) this.ownerDocument.activeElement = this; }
  remove() { if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; }
  get textContent() { return this.ownText + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = value; }
}
const nodes = (root, tag) => root.childNodes.flatMap(node => [...(node.tag === tag ? [node] : []), ...nodes(node, tag)]);
const button = (root, label) => { const found = nodes(root, 'button').find(node => node.textContent === label); assert.ok(found, label); return found; };
const failed = { id: 'retained-id', key: 'private-key', path: 'attach', size: 22, status: 'failed', errorCode: 'CONTENT_TYPE_NOT_ALLOWED' };
async function fixture(t) {
  const document = { createElement: tag => new Element(tag, document), defaultView: { confirm: () => true } };
  document.body = document.createElement('body'); document.activeElement = document.body;
  const root = document.createElement('div'), elsewhere = document.createElement('input'); document.body.append(root, elsewhere);
  let items = [failed], listener, resolve, reject; const calls = [];
  const queue = {
    snapshot: async () => items,
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
    retry(id) { calls.push(['retry', id]); return new Promise((done, fail) => { resolve = done; reject = fail; }); },
    discard(id) { calls.push(['discard', id]); return new Promise((done, fail) => { resolve = done; reject = fail; }); },
    flush: async () => {},
  };
  const dispose = mountOfflineAttachmentQueue(root, queue); t.after(dispose); await settle();
  return { root, document, elsewhere, calls, queue, dispose, emit(value) { items = value; listener?.(items); }, succeed() { resolve(); }, fail() { reject(Error('Held action failed')); } };
}

test('retry keeps keyboard focus through failure-to-pending redraw and blocks repeat row actions until settlement', async t => {
  const f = await fixture(t), retry = button(f.root, 'Retry'); retry.focus();
  const action = retry.onclick();
  assert.equal(f.document.activeElement, retry, 'starting Retry must not blur its focused control');
  assert.equal(retry.getAttribute('aria-disabled'), 'true');
  await retry.onclick(); await button(f.root, 'Discard local copy').onclick();
  f.emit([{ ...failed, status: 'pending', errorCode: undefined }]);
  const replacement = button(f.root, 'Retry'); assert.notEqual(replacement, retry);
  assert.equal(f.document.activeElement, replacement); assert.equal(replacement.getAttribute('aria-disabled'), 'true');
  await replacement.onclick(); await button(f.root, 'Discard local copy').onclick();
  assert.deepEqual(f.calls, [['retry', failed.id]]);
  f.succeed(); await action;
  assert.equal(f.document.activeElement, replacement); assert.equal(replacement.getAttribute('aria-disabled'), 'false');
  await retry.onclick(); assert.equal(f.calls.length, 1, 'a detached old action must remain inert');
  const again = replacement.onclick(); assert.equal(f.calls.length, 2); f.succeed(); await again;
});

for (const outcome of ['success', 'failure']) test(`held retry ${outcome} respects focus moved outside the view`, async t => {
  const f = await fixture(t), retry = button(f.root, 'Retry'); retry.focus(); const action = retry.onclick();
  f.elsewhere.focus(); f.emit([{ ...failed, status: 'pending', errorCode: undefined }]);
  assert.equal(f.document.activeElement, f.elsewhere);
  if (outcome === 'success') f.succeed(); else f.fail(); await action;
  assert.equal(f.document.activeElement, f.elsewhere);
  if (outcome === 'failure') assert.match(f.root.textContent, /Could not change pending attachment/);
  assert.equal(button(f.root, 'Retry').getAttribute('aria-disabled'), 'false');
});

test('failed retry leaves a different action focused, but announces failure at the still-focused retry', async t => {
  const f = await fixture(t), retry = button(f.root, 'Retry'); retry.focus(); let action = retry.onclick();
  const discard = button(f.root, 'Discard local copy'); discard.focus(); f.fail(); await action;
  assert.equal(f.document.activeElement, discard);
  retry.focus(); action = retry.onclick(); f.fail(); await action;
  assert.equal(f.document.activeElement.getAttribute('role'), 'status');
  assert.match(f.document.activeElement.textContent, /Could not change pending attachment/);
});

test('discard moves removed-row focus to status and disposal fences stale controls and late failure', async t => {
  const f = await fixture(t), discard = button(f.root, 'Discard local copy'); discard.focus();
  const action = discard.onclick(); f.emit([]); f.succeed(); await action;
  assert.equal(f.document.activeElement.getAttribute('role'), 'status'); assert.match(f.root.textContent, /0 pending attachments/);
  f.emit([failed]); const retry = button(f.root, 'Retry'); retry.focus(); const held = retry.onclick();
  f.dispose(); f.elsewhere.focus(); f.fail(); await held; await retry.onclick();
  assert.equal(f.document.activeElement, f.elsewhere); assert.equal(f.root.childNodes.length, 0);
  assert.deepEqual(f.calls, [['discard', failed.id], ['retry', failed.id]]);
});

test('a redraw does not take focus from another queue showing the same attachment metadata', async t => {
  const f = await fixture(t), other = f.document.createElement('div'); f.document.body.append(other);
  const dispose = mountOfflineAttachmentQueue(other, { ...f.queue, subscribe() { return () => {}; } }); t.after(dispose); await settle();
  const elsewhere = button(other, 'Retry'); elsewhere.focus(); f.emit([{ ...failed, status: 'pending', errorCode: undefined }]);
  assert.equal(f.document.activeElement, elsewhere);
});

test('uploading and attaching controls keep native disabled behavior and reject stale invocation', async t => {
  const f = await fixture(t);
  for (const status of ['uploading', 'attaching']) {
    f.emit([{ ...failed, status }]);
    for (const label of ['Retry', 'Discard local copy']) { const action = button(f.root, label); assert.equal(action.disabled, true); await action.onclick(); }
  }
  assert.deepEqual(f.calls, []);
});
