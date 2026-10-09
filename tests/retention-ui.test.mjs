import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRetentionAdministration } from '../dist/retention-administration.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(tag, document) { Object.assign(this, { tag, ownerDocument: document, childNodes: [], listeners: new Map(), style: {}, attributes: new Map(), ownText: '', value: '', disabled: false, checked: false }); }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.ownText = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, listener) { const list = this.listeners.get(name) ?? []; list.push(listener); this.listeners.set(name, list); }
  async fire(name) { for (const listener of this.listeners.get(name) ?? []) listener({ target: this }); await settle(); }
  focus() { this.ownerDocument.activeElement = this; }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; }
  get textContent() { return this.ownText + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = value; }
}
function fixture() { const document = { createElement: tag => new Element(tag, document), createTextNode: text => { const node = new Element('#text', document); node.textContent = text; return node; } }; document.body = document.createElement('body'); document.activeElement = document.body; const root = document.createElement('div'); document.body.append(root); return root; }
const nodes = (root, tag) => root.childNodes.flatMap(node => [...(node.tag === tag ? [node] : []), ...nodes(node, tag)]);
const button = (root, text) => { const value = nodes(root, 'button').find(node => node.textContent === text); assert.ok(value, text); return value; };
const field = (root, label) => { const value = nodes(root, 'label').find(node => node.ownText === `${label} `)?.childNodes[0]; assert.ok(value, label); return value; };
const resource = { kind: 'import', id: '<script>private', state: 'completed', payloadRows: 1, payloadBytes: 100, receiptRows: 2, historyRows: 3, protectedRows: 1, hold: null };
const inventory = () => ({ scope: 'one', resources: [resource], next: 'next' });
const preview = selection => ({ ...selection, protocol: 'clank-retention/1', digest: 'snapshot', items: [{ ...selection.resources[0], records: 3, blocked: null }], records: 3, bytes: 100, holdRevision: 0, policyRevision: 'test/1' });
const rule = { id: 'private-rule', scope: 'one', version: 4, kinds: ['import'], olderThanMs: 86400000, everyMs: 60000, maxDeletes: 1000, state: 'active' };
async function select(root) { const input = nodes(root, 'input').find(node => node.parentNode.tag === 'label' && node.parentNode.childNodes.some(child => child.tag === '#text')); assert.ok(input); input.checked = true; await input.fire('change'); }

test('retention UI reviews exact data and retries an uncertain purge with the same operation identity', async () => {
  const root = fixture(), accepted = []; let tries = 0;
  const dispose = mountRetentionAdministration(root, { client: { inventory: async () => inventory(), preview: async selection => preview(selection), accept: async (value, id) => { accepted.push({ value, id }); if (!tries++) throw Error('Response lost'); return { records: 3 }; } }, currentUser: () => 'actor', scope: () => 'one', kinds: ['import'] });
  await settle(); assert.match(root.textContent, /<script>private/); assert.equal(nodes(root, 'script').length, 0);
  await select(root); await button(root, 'Review purge').fire('click'); assert.match(root.textContent, /3 records/);
  await button(root, 'Accept reviewed purge').fire('click'); assert.match(root.textContent, /Response lost/);
  await button(root, 'Accept reviewed purge').fire('click'); assert.equal(accepted.length, 2); assert.deepEqual(accepted[0], accepted[1]); assert.ok(accepted[0].id); assert.match(root.textContent, /Retired 3 records/); assert.doesNotMatch(root.textContent, /private/); dispose(); assert.equal(root.childNodes.length, 0);
});

test('account and scope changes clear private forms and fence stale rule controls and late responses', async () => {
  const root = fixture(); let actor = 'actor', scope = 'one', resolve, calls = 0;
  const dispose = mountRetentionAdministration(root, { client: { inventory: async () => inventory(), schedules: async () => [rule], preview: () => new Promise(done => { resolve = done; calls++; }) }, currentUser: () => actor, scope: () => scope, kinds: ['import'] });
  await settle(); field(root, 'Reason').value = 'Private evidence'; await button(root, 'Load rules').fire('click'); const oldEdit = button(root, 'Edit rule'); await oldEdit.fire('click'); assert.equal(field(root, 'Rule name').value, 'private-rule');
  await select(root); await button(root, 'Review purge').fire('click'); assert.equal(calls, 1); actor = 'other'; scope = 'two'; resolve(preview({ scope: 'one', resources: [resource], cutoff: 1, maxDeletes: 100 })); await settle();
  assert.doesNotMatch(root.textContent, /private/); assert.equal(field(root, 'Reason').value, ''); assert.equal(field(root, 'Rule name').value, ''); assert.equal(button(root, 'Accept reviewed purge').disabled, true);
  await oldEdit.fire('click'); assert.equal(field(root, 'Rule name').value, ''); dispose(); await oldEdit.fire('click'); assert.equal(root.childNodes.length, 0);
});

test('revocation clears inventory, preview and forms; disposal drops outstanding success without stealing focus', async () => {
  const root = fixture(); let revoked = false, resolve;
  const dispose = mountRetentionAdministration(root, { client: { inventory: async () => { if (revoked) throw Object.assign(Error('Revoked'), { status: 403 }); return inventory(); }, preview: () => new Promise(done => { resolve = done; }) }, currentUser: () => 'actor', scope: () => 'one' });
  await settle(); field(root, 'Reason').value = 'Private evidence'; revoked = true; await button(root, 'Refresh inventory').fire('click'); assert.equal(field(root, 'Reason').value, ''); assert.doesNotMatch(root.textContent, /private/); assert.match(root.textContent, /Revoked/);
  revoked = false; await button(root, 'Refresh inventory').fire('click'); await select(root); await button(root, 'Review purge').fire('click'); const elsewhere = root.ownerDocument.createElement('input'); root.ownerDocument.body.append(elsewhere); elsewhere.focus(); dispose(); resolve(preview({ scope: 'one', resources: [resource] })); await settle(); assert.equal(root.childNodes.length, 0); assert.equal(root.ownerDocument.activeElement, elsewhere);
});

test('holds and rules retry unchanged input, retain version fences and serialize clicks while pending', async () => {
  const root = fixture(), holds = [], saved = []; let holdTry = 0, saveTry = 0, pending;
  const dispose = mountRetentionAdministration(root, { client: { inventory: async () => inventory(), schedules: async () => [rule], hold: async (...args) => { holds.push(args); if (!holdTry++) throw Error('Hold response lost'); return { version: 1 }; }, saveSchedule: (input, id) => { saved.push({ input, id }); if (!saveTry++) return Promise.reject(Error('Rule response lost')); return new Promise(done => { pending = done; }); } }, currentUser: () => 'actor', scope: () => 'one', kinds: ['import'] });
  await settle(); await select(root); field(root, 'Reason').value = 'Evidence'; await button(root, 'Save hold').fire('click'); await button(root, 'Save hold').fire('click'); assert.deepEqual(holds[0], holds[1]); assert.equal(holds[0][2], 0);
  await button(root, 'Load rules').fire('click'); await button(root, 'Edit rule').fire('click'); await button(root, 'Save rule').fire('click'); await button(root, 'Save rule').fire('click'); assert.equal(button(root, 'Save rule').disabled, true); await button(root, 'Save rule').fire('click'); assert.equal(saved.length, 2); assert.deepEqual(saved[0], saved[1]); assert.equal(saved[0].input.expectedVersion, 4); pending({ version: 5 }); await settle(); assert.match(root.textContent, /Cleanup rule saved/); dispose();
});
