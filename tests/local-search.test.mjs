import test from 'node:test';import assert from 'node:assert/strict';
import {createLocalSearchIndex} from '../dist/local-search.js';
test('local search ranks title matches, folds accents, intersects terms, highlights original text, and supports pages',()=>{
 const index=createLocalSearchIndex();index.replace([{id:'coffee',title:'Café notes',body:'A quiet café for weekly planning.'},{id:'body',title:'Weekly notes',body:'We stopped at a cafe.'},{id:'other',title:'Garden',body:'Plant the beans.'}]);
 const result=index.search('cafe');assert.equal(result.total,2);assert.equal(result.hits[0].id,'coffee');assert.deepEqual(result.hits[0].title[0],{text:'Café',match:true});
 assert.equal(index.search('cafe quiet').total,1);assert.equal(index.search('caf',{prefix:false}).total,0);assert.equal(index.search('caf').total,2);
 assert.equal(index.search('cafe',{offset:1,limit:1}).hits[0].id,'body');assert.equal(index.search('').total,0);assert.equal(index.search('missing').total,0);
});
test('upserts remove stale terms, snapshots survive restart, and rejected replacements leave the previous index intact',()=>{
 const index=createLocalSearchIndex({maxDocuments:2});index.upsert({id:'one',title:'Before',body:'old token'});index.upsert({id:'one',title:'After',body:'new token'});assert.equal(index.search('old').total,0);assert.equal(index.search('after').total,1);
 const restored=createLocalSearchIndex({maxDocuments:2});restored.restore(index.serialize());assert.deepEqual(restored.search('new'),index.search('new'));
 assert.throws(()=>restored.replace([{id:'a',title:'A',body:''},{id:'a',title:'B',body:''}]),/unique/);assert.equal(restored.size,1);
 assert.throws(()=>restored.restore(JSON.stringify({version:2,documents:[]})),/Unsupported/);assert.equal(restored.search('new').total,1);
 assert.throws(()=>restored.replace([{id:'a',title:'A',body:''},{id:'b',title:'',body:''}]),/title/);assert.equal(restored.search('new').total,1);
 assert.equal(restored.remove('one'),true);assert.equal(restored.remove('one'),false);assert.equal(restored.search('new').total,0);
});
test('memory, query complexity, and prefix expansion stay bounded with explicit partial-result evidence',()=>{
 const tiny=createLocalSearchIndex({maxBytes:1024});tiny.upsert({id:'old',title:'Original',body:''});assert.throws(()=>tiny.upsert({id:'old',title:'Changed',body:'x'.repeat(2000)}),/capacity/);assert.equal(tiny.search('original').total,1);
 const index=createLocalSearchIndex();index.replace(Array.from({length:80},(_,i)=>({id:String(i),title:`prefix${i}`,body:''})));const result=index.search('prefix');assert.equal(result.truncated,true);assert.equal(result.total,49);
 assert.throws(()=>index.search('word '.repeat(50)),/200/);assert.throws(()=>index.search('x',{limit:101}),/page/);
});
test('replacement tokenizes each input once and rejects aggregate capacity without disturbing a warm index',t=>{
 const index=createLocalSearchIndex(),documents=Array.from({length:100},(_,i)=>({id:String(i),title:'Title token',body:'Body token'}));
 const normalize=String.prototype.normalize;let calls=0;
 const spy=t.mock.method(String.prototype,'normalize',function(...args){calls++;return normalize.apply(this,args);});
 try{index.replace(documents);assert.ok(calls<=documents.length*4,`Expected one tokenization pass, observed ${calls} normalized tokens.`);}finally{spy.mock.restore();}
 assert.equal(index.search('title body').total,100);
 const tiny=createLocalSearchIndex({maxBytes:1024});tiny.upsert({id:'old',title:'Original',body:'retained'});tiny.search('orig');const before=tiny.serialize();
 assert.throws(()=>tiny.replace([{id:'a',title:'First',body:'x'.repeat(400)},{id:'b',title:'Second',body:'y'.repeat(400)}]),/capacity/);
 assert.equal(tiny.serialize(),before);assert.equal(tiny.search('orig').hits[0].id,'old');tiny.upsert({id:'old',title:'Updated',body:'current'});assert.equal(tiny.search('updated').total,1);
});
test('prefix expansion seeks its bounded range and sorts unchanged vocabulary only once',t=>{
 const index=createLocalSearchIndex();index.replace(Array.from({length:1000},(_,i)=>({id:`row-${String(i).padStart(4,'0')}`,title:`entry${String(i).padStart(4,'0')}`,body:'common'})));
 const startsWith=String.prototype.startsWith,sort=Array.prototype.sort;let probes=0,sorts=0;
 const prefixSpy=t.mock.method(String.prototype,'startsWith',function(prefix,...args){if(prefix==='entry09')probes++;return startsWith.call(this,prefix,...args);});
 Array.prototype.sort=function(...args){if(this.length>100&&typeof this[0]==='string')sorts++;return sort.apply(this,args);};
 try{
  const result=index.search('entry09');assert.equal(result.total,49);assert.equal(result.truncated,true);assert.equal(result.hits[0].id,'row-0900');assert.ok(probes<=51,`Prefix lookup examined ${probes} terms outside its bounded range.`);
  assert.equal(index.search('entry099').total,10);assert.equal(index.search('comm').total,1000);assert.equal(sorts,1);
 }finally{prefixSpy.mock.restore();Array.prototype.sort=sort;}
});
test('cached prefix vocabulary follows term additions, removals, replacements and restored snapshots',()=>{
 const index=createLocalSearchIndex();index.replace([{id:'one',title:'Café',body:'coffee'},{id:'two',title:'Cart',body:'travel'}]);assert.equal(index.search('ca').total,2);
 index.upsert({id:'three',title:'Canal',body:'water'});assert.equal(index.search('ca').total,3);
 index.remove('two');assert.equal(index.search('car').total,0);assert.equal(index.search('ca').total,2);
 index.upsert({id:'one',title:'Garden',body:'plants'});assert.equal(index.search('caf').total,0);assert.equal(index.search('gar').hits[0].id,'one');
 const saved=index.serialize();index.replace([{id:'new',title:'New',body:'fresh'}]);assert.equal(index.search('ca').total,0);assert.equal(index.search('ne').hits[0].id,'new');
 index.restore(saved);assert.equal(index.search('ne').total,0);assert.equal(index.search('ca').hits[0].id,'three');index.replace([]);assert.equal(index.search('ca').total,0);
});
test('replacement retains document limits and the prior index if an input getter grows the array',()=>{
 const index=createLocalSearchIndex({maxDocuments:1});index.upsert({id:'old',title:'Original',body:'retained'});index.search('orig');
 const inputs=[{id:'first',title:'First',get body(){if(inputs.length===1)inputs.push({id:'second',title:'Second',body:''});return '';}}];
 assert.throws(()=>index.replace(inputs),/capacity/);assert.equal(index.size,1);assert.equal(index.search('orig').hits[0].id,'old');
});
