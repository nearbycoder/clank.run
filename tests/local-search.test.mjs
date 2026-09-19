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
