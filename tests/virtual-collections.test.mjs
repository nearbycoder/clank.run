import assert from 'node:assert/strict';
import test from 'node:test';
import {createVirtualCollection} from '../dist/virtual-collections.js';
const items=Array.from({length:10000},(_,id)=>({id,title:`Row ${id}`}));
const create=()=>createVirtualCollection({items,key:item=>item.id,rowHeight:40,overscan:2});
test('ten thousand rows produce a bounded visible window and retain only one offscreen active row',()=>{
 const model=create();model.setViewport(200000,400);const snapshot=model.snapshot();
 assert.ok(snapshot.items.length<=15);assert.equal(snapshot.totalHeight,400000);
 assert.equal(snapshot.items[1].index,4998);assert.equal(snapshot.items[0].index,0);
 assert.ok(snapshot.items.every(item=>item.offset===item.index*40));
});
test('stable keys preserve visible anchor and focus across prepends, replacement and deletion',()=>{
 const model=create();model.setViewport(4005,400);model.focus(102);model.setViewport(4005,400);
 model.setItems([{id:-1,title:'New'},...items]);assert.equal(model.snapshot().scrollTop,4045);assert.equal(model.snapshot().activeIndex,103);
 model.setItems(items.map(item=>({...item,title:'Updated'})));assert.equal(model.snapshot().scrollTop,4005);assert.equal(model.snapshot().activeIndex,102);
 assert.ok(model.snapshot().items.every(item=>item.value.title==='Updated'));
 model.setItems([]);assert.equal(model.snapshot().scrollTop,0);assert.equal(model.snapshot().activeIndex,-1);assert.equal(model.snapshot().items.length,0);
});
test('keyboard navigation, viewport shrink and bounds never select an unavailable row',()=>{
 const model=create();model.setViewport(0,400);
 assert.equal(model.navigate('End'),true);assert.equal(model.snapshot().activeIndex,9999);assert.equal(model.snapshot().scrollTop,399600);
 model.navigate('Home');model.navigate('PageDown');assert.equal(model.snapshot().activeIndex,10);
 model.navigate('ArrowUp');assert.equal(model.snapshot().activeIndex,9);assert.equal(model.navigate('Escape'),false);
 model.setViewport(-100,400);assert.equal(model.snapshot().scrollTop,0);
 assert.throws(()=>model.setViewport(0,Infinity));assert.throws(()=>model.setItems([{id:1},{id:1}]));
 assert.equal(model.snapshot().count,10000,'invalid input is atomic');
});
test('subscribers detach and duplicate/unbounded keys fail before publication',()=>{
 const model=create();let calls=0;const stop=model.subscribe(()=>calls++);model.setViewport(0,400);assert.equal(calls,1);stop();model.navigate('End');assert.equal(calls,1);
 assert.throws(()=>createVirtualCollection({items:[1],key:()=>NaN,rowHeight:40}));
 assert.throws(()=>createVirtualCollection({items:[],key:x=>x,rowHeight:0}));
});
