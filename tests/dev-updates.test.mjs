import test from 'node:test';
import assert from 'node:assert/strict';
import { installDevelopmentUpdates } from '../scripts/dev-browser.mjs';
import { preserveDevelopmentState } from '../dist/dev-updates.js';
function browser(storage = new Map()) {
  let eventSource, reloads = 0;
  const fields = [], styles = [], byId = new Map();
  const document = { readyState: 'complete', activeElement: null, querySelectorAll: selector => selector.startsWith('link') ? styles : fields, getElementById: id => byId.get(id) };
  const view = { document, location: { href: 'http://localhost:3000/app?x=1', origin: 'http://localhost:3000', pathname: '/app', search: '?x=1', reload: () => reloads++ },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key,value) => storage.set(key,value), removeItem: key => storage.delete(key) }, scrollX: 0, scrollY: 80, scrollTo: (x,y) => { view.scrollX=x; view.scrollY=y; }, requestAnimationFrame: callback => callback(), setTimeout, clearTimeout,
    EventSource: class { constructor(){eventSource=this;} addEventListener(name, callback){this.callback=callback;} close(){this.closed=true;} },
  };
  function field(id,type,value) { const row = { id, type, value, tagName:'INPUT', checked:false, selectionStart:1, selectionEnd:2, matches:()=>true, getAttribute:()=>null, focus:()=>{document.activeElement=row;}, setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;} }; fields.push(row); byId.set(id,row); return row; }
  return {view,field,styles,storage,get reloads(){return reloads;},emit:details=>eventSource.callback({data:JSON.stringify(details)})};
}
test('development reload restores explicit UI snapshots and drafts while excluding password controls', async t => {
  const first = browser(); globalThis.window = first.view; t.after(()=>delete globalThis.window);
  const draft = first.field('draft','text','in progress'); first.field('secret','password','do not persist'); const card = first.field('card','text','4111111111111111'); card.getAttribute = () => 'CC-NUMBER'; first.view.document.activeElement=draft;
  const cleanup = preserveDevelopmentState('selected-tab',{snapshot:()=>({tab:'details'}),restore:()=>{}});
  assert.throws(()=>preserveDevelopmentState('selected-tab',{snapshot:()=>0,restore:()=>{}}),/already registered/);
  const dispose = installDevelopmentUpdates(first.view);
  await first.emit({revision:2,kind:'reload'}); assert.equal(first.reloads,1); assert.doesNotMatch([...first.storage.values()][0],/do not persist|4111111111111111/);
  cleanup(); dispose();
  const second = browser(first.storage); second.view.scrollY=0; globalThis.window=second.view;
  const restored=second.field('draft','text',''); let state;
  preserveDevelopmentState('selected-tab',{snapshot:()=>state,restore:value=>{state=value;}});
  installDevelopmentUpdates(second.view);
  assert.equal(restored.value,'in progress'); assert.deepEqual(state,{tab:'details'}); assert.equal(second.view.document.activeElement,restored); assert.equal(second.view.scrollY,80); assert.equal(second.storage.size,0);
});
test('CSS updates retain document state and a queued code change still triggers recovery reload', async()=>{
  const context=browser(); let replaced=false, next;
  context.styles.push({href:'http://localhost:3000/styles.css',cloneNode:()=>({remove(){}}),after:value=>{next=value;},remove:()=>{replaced=true;}});
  installDevelopmentUpdates(context.view);
  const update=context.emit({revision:2,kind:'styles'});
  await context.emit({revision:3,kind:'reload'}); await context.emit({revision:4,kind:'styles'});
  assert.equal(context.reloads,0); assert.match(next.href,/__clank_dev=2/); next.onload(); await update;
  assert.equal(replaced,true); assert.equal(context.reloads,1);
});
test('expired snapshots are consumed without restoring and oversized snapshots fall back safely',async()=>{
  const storage=new Map([['clank:dev:/app?x=1',JSON.stringify({protocol:'clank-dev-state/1',at:Date.now()-60000,fields:[],states:[]})]]),context=browser(storage);
  context.field('large','text','x'.repeat(70000));installDevelopmentUpdates(context.view);assert.equal(storage.size,0);
  await context.emit({revision:2,kind:'reload'});assert.equal(storage.size,0);assert.equal(context.reloads,1);
});
