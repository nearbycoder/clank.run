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
  showModal() { this.open=true; }
  close() { this.open=false; this.onclose?.(); }
  remove() { if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; }
  get textContent() { return this.ownText + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = value; }
}

for(const label of ['Retry','Synchronize attachments'])test('current refresh failure announces at the focused '+label+' and recovery retains status focus',async t=>{
 const f=await fixture(t),action=button(f.root,label);let reads=0;
 f.queue.snapshot=async()=>{if(++reads===1)throw Error('Declared current snapshot failure');return [failed]};action.focus();
 await observeRefresh(()=>reads===1);assert.equal(f.document.activeElement.getAttribute('role'),'status');assert.match(f.document.activeElement.textContent,/Attachments unavailable for this account/);
 await observeRefresh(()=>reads===2);assert.equal(button(f.root,'Synchronize attachments').disabled,false);assert.equal(f.document.activeElement.getAttribute('role'),'status','successful recovery must not move focus back to an action');
});

for(const movedOutside of [true,false])test('held current refresh failure uses settlement-time focus '+(movedOutside?'outside':'inside')+' the queue',async t=>{
 const f=await fixture(t);let reads=0,reject;
 f.queue.snapshot=()=>{reads++;return new Promise((_,fail)=>reject=fail)};
 if(movedOutside)button(f.root,'Retry').focus();else f.elsewhere.focus();
 await observeRefresh(()=>reads===1);
 if(movedOutside)f.elsewhere.focus();else button(f.root,'Retry').focus();
 reject(Error('Declared held current snapshot failure'));await settle();
 if(movedOutside)assert.equal(f.document.activeElement,f.elsewhere);
 else{assert.equal(f.document.activeElement.getAttribute('role'),'status');assert.match(f.document.activeElement.textContent,/Attachments unavailable for this account/);}
});
const nodes = (root, tag) => root.childNodes.flatMap(node => [...(node.tag === tag ? [node] : []), ...nodes(node, tag)]);
test('discard modal preserves the local copy on Escape and restores its action focus',async t=>{
 const f=await fixture(t),discard=button(f.root,'Discard local copy');discard.focus();const action=discard.onclick(),dialog=nodes(f.root,'dialog')[0];
 assert.equal(dialog.open,true);assert.equal(f.document.activeElement.textContent,'Keep local copy');assert.deepEqual(f.calls,[]);assert.match(dialog.textContent,/does not remove a server file/);
 dialog.oncancel({preventDefault(){}});await action;assert.equal(nodes(f.root,'dialog').length,0);assert.equal(f.document.activeElement,discard);assert.deepEqual(f.calls,[]);
});
test('disposal dismisses an open discard review without changing local storage or another view focus',async t=>{
 const f=await fixture(t),action=button(f.root,'Discard local copy').onclick();assert.equal(nodes(f.root,'dialog').length,1);
 f.dispose();f.elsewhere.focus();await action;assert.deepEqual(f.calls,[]);assert.equal(f.root.childNodes.length,0);assert.equal(f.document.activeElement,f.elsewhere);
});
test('a row replaced during its discard review cannot dispatch the stale action',async t=>{
 const f=await fixture(t),action=button(f.root,'Discard local copy').onclick(),dialog=nodes(f.root,'dialog')[0];
 f.emit([{...failed,status:'uploading'}]);button(dialog,'Discard local copy').onclick();await action;assert.deepEqual(f.calls,[]);assert.equal(f.document.activeElement.getAttribute('role'),'status');
});
test('account snapshot loss dismisses the open discard review and announces current refusal',async t=>{
 const f=await fixture(t),action=button(f.root,'Discard local copy').onclick();let reads=0;
 f.queue.snapshot=async()=>{reads++;throw Error('Account changed')};await observeRefresh(()=>reads>0);await action;await settle();
 assert.equal(nodes(f.root,'dialog').length,0);assert.deepEqual(f.calls,[]);assert.equal(f.document.activeElement.getAttribute('role'),'status');
});
const button = (root, label) => { const found = nodes(root, 'button').find(node => node.textContent === label); assert.ok(found, label); return found; };
const failed = { id: 'retained-id', key: 'private-key', path: 'attach', size: 22, status: 'failed', errorCode: 'CONTENT_TYPE_NOT_ALLOWED' };
async function fixture(t) {
  const document = { createElement: tag => new Element(tag, document), defaultView: { confirm: () => {throw Error('Native confirmation must not be used');} } };
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
  const action = discard.onclick(); const dialog=nodes(f.root,'dialog')[0]; button(dialog,'Discard local copy').onclick(); await settle(); f.emit([]); f.succeed(); await action;
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

test('synchronize retains keyboard focus and admits only one action until settlement', async t => {
  const f = await fixture(t), synchronize = button(f.root, 'Synchronize attachments'), releases = [];
  f.queue.flush = () => { f.calls.push(['flush']); return new Promise(resolve => releases.push(resolve)); };
  synchronize.focus(); const first = synchronize.onclick(), focused = f.document.activeElement, pending = synchronize.getAttribute('aria-disabled');
  const repeated = synchronize.onclick();
  for (const release of releases) release(); await Promise.all([first, repeated]);
  assert.equal(focused, synchronize, 'starting Synchronize must not blur its focused control');
  assert.equal(pending, 'true'); assert.deepEqual(f.calls, [['flush']]);
  assert.equal(synchronize.getAttribute('aria-disabled'), 'false');
  const next = synchronize.onclick(); releases.at(-1)(); await next; assert.equal(f.calls.length, 2);
});

for (const moved of [false, true]) test(`held synchronize failure ${moved ? 'respects moved focus' : 'announces at the still-focused action'}`, async t => {
  const f = await fixture(t), synchronize = button(f.root, 'Synchronize attachments'); let reject;
  f.queue.flush = () => new Promise((_, fail) => { reject = fail; });
  synchronize.focus(); const action = synchronize.onclick(); if (moved) f.elsewhere.focus();
  reject(Error('Held synchronization failed')); await action;
  assert.match(f.root.textContent, /Attachments unavailable/);
  if (moved) assert.equal(f.document.activeElement, f.elsewhere);
  else assert.equal(f.document.activeElement.getAttribute('role'), 'status');
});

test('disposed synchronization controls and late failures cannot submit or change another view', async t => {
  const f = await fixture(t), synchronize = button(f.root, 'Synchronize attachments'); let reject;
  f.queue.flush = () => { f.calls.push(['flush']); return new Promise((_, fail) => { reject = fail; }); };
  const held = synchronize.onclick(); f.dispose(); f.elsewhere.focus(); reject(Error('Late failure')); await held;
  f.queue.flush = async () => { f.calls.push(['stale flush']); };
  await synchronize.onclick();
  assert.deepEqual(f.calls, [['flush']]); assert.equal(f.document.activeElement, f.elsewhere); assert.equal(f.root.childNodes.length, 0);
});

async function observeRefresh(check) {
  const deadline=Date.now()+4000;
  while(!check()){if(Date.now()>=deadline)throw Error('Expected current refresh was not observed.');await new Promise(resolve=>setTimeout(resolve,10));}
}

test('current successful refresh restores Synchronize after a transient snapshot error without taking focus',async t=>{
 const f=await fixture(t),synchronize=button(f.root,'Synchronize attachments');let reads=0;
 f.queue.snapshot=async()=>{if(++reads===1)throw Error('Declared transient snapshot failure');return [failed]};f.elsewhere.focus();
 await observeRefresh(()=>reads===1);assert.equal(synchronize.disabled,true);assert.equal(synchronize.getAttribute('aria-disabled'),'true');assert.match(f.root.textContent,/Attachments unavailable for this account/);
 await observeRefresh(()=>reads===2);assert.match(f.root.textContent,/1 pending attachment/);assert.equal(button(f.root,'Retry').disabled,false);assert.equal(synchronize.disabled,false);assert.equal(synchronize.getAttribute('aria-disabled'),'false');assert.equal(f.document.activeElement,f.elsewhere);
 f.queue.flush=async()=>{f.calls.push(['flush'])};await synchronize.onclick();assert.deepEqual(f.calls,[['flush']]);
});

test('recovered snapshot keeps a pending Synchronize guarded until its actual outcome',async t=>{
 const f=await fixture(t),synchronize=button(f.root,'Synchronize attachments'),releases=[];let reads=0;
 f.queue.flush=()=>{f.calls.push(['flush']);return new Promise(resolve=>releases.push(resolve))};const first=synchronize.onclick();
 f.queue.snapshot=async()=>{if(++reads===1)throw Error('Declared transient snapshot failure');return [failed]};
 await observeRefresh(()=>reads===1);assert.equal(synchronize.disabled,true);
 await observeRefresh(()=>reads===2);assert.equal(synchronize.disabled,false);assert.equal(synchronize.getAttribute('aria-disabled'),'true');await synchronize.onclick();assert.deepEqual(f.calls,[['flush']]);
 releases[0]();await first;assert.equal(synchronize.getAttribute('aria-disabled'),'false');const next=synchronize.onclick();releases[1]();await next;assert.deepEqual(f.calls,[['flush'],['flush']]);
});

test('late successful refresh after disposal cannot reactivate detached synchronization',async t=>{
 const f=await fixture(t),synchronize=button(f.root,'Synchronize attachments');let reads=0,release;
 f.queue.snapshot=async()=>{if(++reads===1)throw Error('Declared transient snapshot failure');return new Promise(resolve=>{release=resolve})};
 await observeRefresh(()=>reads===1);assert.equal(synchronize.disabled,true);await observeRefresh(()=>reads===2);f.dispose();f.elsewhere.focus();release([failed]);await settle();
 f.queue.flush=async()=>{f.calls.push(['flush'])};await synchronize.onclick();assert.equal(synchronize.disabled,true);assert.equal(synchronize.getAttribute('aria-disabled'),'true');assert.equal(f.root.childNodes.length,0);assert.equal(f.document.activeElement,f.elsewhere);assert.deepEqual(f.calls,[]);
});

for(const newer of ['subscription','snapshot'])test('late failed snapshot cannot replace a newer '+newer+' or steal its focus',async t=>{
 const f=await fixture(t),synchronize=button(f.root,'Synchronize attachments');let reads=0,reject;const current={...failed,status:'pending',errorCode:undefined};
 f.queue.snapshot=async()=>{if(++reads===1)return new Promise((resolve,fail)=>{reject=fail});return [current];};
 await observeRefresh(()=>reads===1);if(newer==='subscription')f.emit([current]);else await observeRefresh(()=>reads===2);
 const retry=button(f.root,'Retry');retry.focus();assert.match(f.root.textContent,/pending attachment/);assert.equal(synchronize.disabled,false);reject(Error('Declared superseded snapshot failure'));await settle();
 assert.equal(button(f.root,'Retry'),retry);assert.equal(f.document.activeElement,retry);assert.equal(synchronize.disabled,false);assert.equal(synchronize.getAttribute('aria-disabled'),'false');assert.doesNotMatch(f.root.textContent,/unavailable/);
});
