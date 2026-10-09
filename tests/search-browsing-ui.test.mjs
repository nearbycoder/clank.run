import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSearchBrowsing } from '../dist/search.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(tag, document) { Object.assign(this, { tag, ownerDocument: document, childNodes: [], listeners: new Map(), style: {}, attributes: new Map(), ownText: '', value: '', _disabled: false }); }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
  get disabled() { return this._disabled; }
  set disabled(value) { this._disabled = value; if (value && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.ownText = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { const list = this.listeners.get(name) ?? []; list.push(listener); this.listeners.set(name, list); }
  async fire(name) { for (const listener of this.listeners.get(name) ?? []) listener({ target: this, preventDefault() {} }); await settle(); }
  focus() { if (this.isConnected && !this.disabled) this.ownerDocument.activeElement = this; }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; }
  querySelectorAll(selector) { return nodes(this).filter(node => selector.split(',').includes(node.tag)); }
  get textContent() { return this.ownText + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = value; }
}
function fixture() { const document = { createElement: tag => new Element(tag, document), createTextNode: text => { const node = new Element('#text', document); node.textContent = text; return node; } }; document.body = document.createElement('body'); document.activeElement = document.body; const root = document.createElement('div'); document.body.append(root); return root; }
const nodes = root => root.childNodes.flatMap(node => [node, ...nodes(node)]);
const button = (root, text) => { const found = nodes(root).find(node => node.tag === 'button' && node.textContent === text); assert.ok(found, text); return found; };
const field = (root, label) => { const found = nodes(root).find(node => node.attributes.get('aria-label') === label); assert.ok(found, label); return found; };
const page = (nextCursor = 'page-2') => ({ total: 2, hits: [{ id: 'record', title: '<script>Private title', snippet: '<img>Private snippet', score: 1 }], facets: [{ field: 'category', values: [{ value: 'alpha', count: 2 }] }], nextCursor, revision: 1 });
const definition = { text: 'launch', sort: 'title', filters: [{ field: 'category', value: 'alpha' }] };
const saved = { key: 'one', name: 'Private saved', revision: 2, usable: true, definition };
const mount = (root, client, extra = {}) => mountSearchBrowsing(root, { client, currentUser: () => 'user', scope: () => 'scope', fields: ['category'], open() {}, ...extra });

test('search controls render values as text, page by pinned cursors and invalidate changed filters', async () => {
  const root = fixture(), calls = [], opened = [];
  const dispose = mount(root, { saved: async () => [], browse: async (...args) => { calls.push(args); return page(calls.length === 1 ? 'page-2' : null); } }, { open: id => opened.push(id) }); await settle();
  assert.equal(root.ownerDocument.activeElement, root.ownerDocument.body, 'initial loading must not steal focus');
  const submit = button(root, 'Search'); submit.focus(); await field(root, 'Browse search records').fire('submit'); assert.match(root.textContent, /<script>Private title/); assert.equal(nodes(root).some(node => node.tag === 'script'), false); assert.equal(root.ownerDocument.activeElement, submit);
  await button(root, '<script>Private title').fire('click'); assert.deepEqual(opened, ['record']);
  button(root, 'Next results').focus(); await button(root, 'Next results').fire('click'); assert.equal(calls[1][2].cursor, 'page-2'); assert.equal(button(root, 'Next results').disabled, true); assert.equal(root.ownerDocument.activeElement, submit);
  field(root, 'Filter category').value = '"alpha"'; await field(root, 'Filter category').fire('change'); assert.doesNotMatch(root.textContent, /Private title/);
  await field(root, 'Browse search records').fire('submit'); assert.deepEqual(calls[2][1].filters, [{ field: 'category', value: 'alpha' }]); assert.equal(calls[2][2].cursor, undefined); dispose(); assert.equal(root.childNodes.length, 0);
});

test('saved controls retain uncertain creation keys and current edit versions without duplicate clicks', async () => {
  const root = fixture(), saves = [], removed = []; let rows = [], fail = true;
  const dispose = mount(root, { saved: async () => rows, browse: async () => page(null), save: async (_scope, input) => { saves.push(input); if (fail) { fail = false; throw Error('Unknown response'); } const value = { key: input.key, name: input.name, revision: input.expectedRevision + 1, usable: true, definition: input.definition }; rows = [value]; return value; }, removeSaved: async (_scope, key, revision) => { removed.push({ key, revision }); rows = []; } }); await settle();
  field(root, 'Saved search name').value = 'Mine'; await button(root, 'Save search').fire('click'); await button(root, 'Save search').fire('click'); assert.deepEqual(saves[0], saves[1]);
  button(root, 'Load Mine').focus(); await button(root, 'Load Mine').fire('click'); assert.equal(root.ownerDocument.activeElement, field(root, 'Saved search name'));
  field(root, 'Saved search name').value = 'Edited'; await button(root, 'Save search').fire('click'); assert.equal(saves[2].expectedRevision, 1); assert.equal(saves[2].key, saves[0].key);
  await button(root, 'Delete Edited').fire('click'); assert.deepEqual(removed, [{ key: saves[0].key, revision: 2 }]); assert.equal(field(root, 'Saved search name').value, ''); dispose();
});

test('account changes clear private forms and late pages; stale saved and open controls stay fenced', async () => {
  const root = fixture(); let actor = 'user', scope = 'scope', resolve, opened = 0, loads = 0;
  const dispose = mount(root, { saved: async () => [saved], browse: () => { loads++; return new Promise(done => { resolve = done; }); } }, { currentUser: () => actor, scope: () => scope, open: () => opened++ }); await settle(); const oldLoad = button(root, 'Load Private saved');
  field(root, 'Saved search name').value = 'Private draft'; field(root, 'Search words').value = 'Private words'; await field(root, 'Browse search records').fire('submit'); actor = 'other'; scope = 'different'; resolve(page()); await settle();
  assert.equal(field(root, 'Saved search name').value, ''); assert.equal(field(root, 'Search words').value, ''); assert.doesNotMatch(root.textContent, /Private/); assert.equal(button(root, 'Next results').disabled, true);
  await oldLoad.fire('click'); assert.equal(loads, 1); assert.equal(opened, 0); dispose(); await oldLoad.fire('click'); assert.equal(root.childNodes.length, 0);
});

test('revocation clears saved filters and disclosure; disposal drops replies and preserves outside focus', async () => {
  const root = fixture(); let revoked = false, resolve;
  const dispose = mount(root, { saved: async () => { if (revoked) throw Object.assign(Error('Revoked'), { status: 403 }); return [saved]; }, browse: () => new Promise(done => { resolve = done; }) }); await settle(); field(root, 'Saved search name').value = 'Private draft';
  revoked = true; await button(root, 'Refresh saved searches').fire('click'); assert.doesNotMatch(root.textContent, /Private/); assert.equal(field(root, 'Saved search name').value, ''); assert.match(root.textContent, /access revoked/);
  revoked = false; await field(root, 'Browse search records').fire('submit'); const elsewhere = root.ownerDocument.createElement('input'); root.ownerDocument.body.append(elsewhere); elsewhere.focus(); dispose(); resolve(page()); await settle(); assert.equal(root.childNodes.length, 0); assert.equal(root.ownerDocument.activeElement, elsewhere);
});
